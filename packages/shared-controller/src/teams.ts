import { Ledger, opaque, type Session } from './ledger.js';

const INVITATION_MS = 7 * 24 * 3600_000;
const TEAM_ID = /^[A-Za-z0-9_-]{43}$/;
const ACTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class TeamError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'TeamError'; }
}

export interface TeamSummary {
  id: string; name: string; creatorId: string; generation: number; createdAt: number;
}
export interface TeamInvitation extends TeamSummary { invitation: string; expiresAt: number; }
export interface TeamMember { actorId: string; state: 'member' | 'invited'; available: boolean; expiresAt: number | null; }
export interface TeamEvent { sequence: number; time: number; actorId: string; action: string; subjectId: string | null; }
export interface TeamAuthority { readonly session: Readonly<Session>; readonly teamId: string; readonly generation: number; }

/** Local membership metadata only: never runtime files, resource content or credentials.
 * All mutations recheck the durable caller and compare the displayed generation in
 * the same SQLite transaction. Invitations confer no membership until accepted. */
export class Teams {
  constructor(private readonly ledger: Ledger) {}

  private actor(session: Session): void {
    if (!this.ledger.sessionCurrent(session)) throw new TeamError(401, 'Your session ended. Sign in again.');
  }

  private accountAvailable(actorId: string): boolean {
    return Boolean(this.ledger.db.prepare(`SELECT 1 FROM actors a JOIN runtimes r ON r.actor_id=a.id
      JOIN passwords p ON p.actor_id=a.id WHERE a.id=? AND a.enabled=1 AND r.enabled=1`).get(actorId));
  }

  private member(session: Session, teamId: string): TeamSummary {
    this.actor(session);
    if (!TEAM_ID.test(teamId)) throw new TeamError(404, 'Team unavailable.');
    const row = this.ledger.db.prepare(`SELECT t.id,t.name,t.creator_id AS creatorId,t.generation,t.created_at AS createdAt
      FROM teams t JOIN team_members m ON m.team_id=t.id
      WHERE t.id=? AND t.archived=0 AND m.actor_id=? AND m.state='member'`).get(teamId, session.actorId);
    if (!row) throw new TeamError(404, 'Team unavailable.');
    return row as unknown as TeamSummary;
  }

  private version(team: TeamSummary, expected: number): void {
    if (!Number.isSafeInteger(expected) || team.generation !== expected) {
      throw new TeamError(409, 'This team changed. Reload the page before trying again.');
    }
  }

  private creator(session: Session, teamId: string, expected: number): TeamSummary {
    const team = this.member(session, teamId);
    if (team.creatorId !== session.actorId) throw new TeamError(403, 'Only the team creator can manage membership.');
    this.version(team, expected); return team;
  }

  private name(value: string): string {
    const name = value.trim().normalize('NFC');
    if (!name || name.length > 80 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
      throw new TeamError(400, 'Use a team name of 1–80 characters without control characters.');
    }
    return name;
  }

  private event(teamId: string, session: Session, action: string, subjectId: string | null = null): void {
    this.ledger.db.prepare('UPDATE teams SET generation=generation+1 WHERE id=?').run(teamId);
    this.ledger.db.prepare('INSERT INTO team_events(team_id,time,actor_id,action,subject_id) VALUES(?,?,?,?,?)')
      .run(teamId, Date.now(), session.actorId, action, subjectId);
    // Directory activity has bounded retention. Resource revision history is a
    // separate contract; never use these entries as resource snapshots.
    this.ledger.db.prepare(`DELETE FROM team_events WHERE team_id=? AND sequence NOT IN
      (SELECT sequence FROM team_events WHERE team_id=? ORDER BY sequence DESC LIMIT 200)`).run(teamId, teamId);
  }

  list(session: Session): { teams: TeamSummary[]; invitations: TeamInvitation[] } {
    return this.ledger.transaction(() => this.listCurrent(session));
  }

  private listCurrent(session: Session): { teams: TeamSummary[]; invitations: TeamInvitation[] } {
    this.actor(session);
    const columns = 't.id,t.name,t.creator_id AS creatorId,t.generation,t.created_at AS createdAt';
    const teams = this.ledger.db.prepare(`SELECT ${columns} FROM teams t JOIN team_members m ON m.team_id=t.id
      WHERE t.archived=0 AND m.actor_id=? AND m.state='member' ORDER BY t.created_at,t.id`).all(session.actorId);
    const invitations = this.ledger.db.prepare(`SELECT ${columns},m.invitation,m.expires_at AS expiresAt
      FROM teams t JOIN team_members m ON m.team_id=t.id JOIN actors a ON a.id=t.creator_id
      JOIN runtimes r ON r.actor_id=a.id WHERE t.archived=0 AND m.actor_id=? AND m.state='invited'
      AND m.expires_at>? AND a.enabled=1 AND r.enabled=1 ORDER BY t.created_at,t.id`).all(session.actorId, Date.now());
    return { teams: teams as unknown as TeamSummary[], invitations: invitations as unknown as TeamInvitation[] };
  }

  detail(session: Session, teamId: string): { team: TeamSummary; members: TeamMember[]; events: TeamEvent[] } {
    return this.ledger.transaction(() => this.detailCurrent(session, teamId));
  }

  private detailCurrent(session: Session, teamId: string): { team: TeamSummary; members: TeamMember[]; events: TeamEvent[] } {
    const team = this.member(session, teamId);
    const rows = this.ledger.db.prepare(`SELECT m.actor_id AS actorId,m.state,m.expires_at AS expiresAt,
      (a.enabled=1 AND r.enabled=1) AS available FROM team_members m JOIN actors a ON a.id=m.actor_id
      JOIN runtimes r ON r.actor_id=m.actor_id WHERE m.team_id=? AND (m.state='member'
      OR (m.state='invited' AND m.expires_at>?)) ORDER BY m.state,m.actor_id`).all(teamId, Date.now());
    const events = this.ledger.db.prepare(`SELECT sequence,time,actor_id AS actorId,action,subject_id AS subjectId
      FROM team_events WHERE team_id=? ORDER BY sequence DESC LIMIT 200`).all(teamId);
    return { team, members: rows.map(row => ({ ...row, available: row.available === 1 })) as unknown as TeamMember[],
      events: events as unknown as TeamEvent[] };
  }

  create(session: Session, value: string): string {
    const name = this.name(value);
    return this.ledger.transaction(() => {
      this.actor(session);
      if (Number(this.ledger.db.prepare('SELECT count(*) AS n FROM teams').get()?.n) >= 4096
          || Number(this.ledger.db.prepare('SELECT count(*) AS n FROM teams WHERE creator_id=?').get(session.actorId)?.n) >= 512) {
        throw new TeamError(409, 'The retained team directory limit is reached. Contact your installation administrator.');
      }
      if (Number(this.ledger.db.prepare('SELECT count(*) AS n FROM teams WHERE archived=0').get()?.n) >= 256
          || Number(this.ledger.db.prepare('SELECT count(*) AS n FROM teams WHERE creator_id=? AND archived=0').get(session.actorId)?.n) >= 32) {
        throw new TeamError(409, 'The active team limit is reached. Archive an unused team first.');
      }
      const id = opaque();
      this.ledger.db.prepare('INSERT INTO teams(id,name,creator_id,created_at) VALUES(?,?,?,?)').run(id, name, session.actorId, Date.now());
      this.ledger.db.prepare("INSERT INTO team_members(team_id,actor_id,state) VALUES(?,?,'member')").run(id, session.actorId);
      this.event(id, session, 'created'); return id;
    });
  }

  rename(session: Session, teamId: string, expected: number, value: string): void {
    const name = this.name(value);
    this.ledger.transaction(() => {
      const team = this.creator(session, teamId, expected);
      if (team.name === name) return;
      this.ledger.db.prepare('UPDATE teams SET name=? WHERE id=?').run(name, teamId);
      this.event(teamId, session, 'renamed');
    });
  }

  invite(session: Session, teamId: string, expected: number, actorId: string): void {
    this.ledger.transaction(() => {
      this.creator(session, teamId, expected);
      if (!ACTOR_ID.test(actorId) || !this.accountAvailable(actorId)) {
        throw new TeamError(400, 'That local account is unavailable. Check its exact account ID.');
      }
      const existing = this.ledger.db.prepare('SELECT state,expires_at FROM team_members WHERE team_id=? AND actor_id=?').get(teamId, actorId);
      if (existing?.state === 'member' || (existing?.state === 'invited' && Number(existing.expires_at) > Date.now())) {
        throw new TeamError(409, 'This account is already a member or has a pending invitation.');
      }
      const occupied = Number(this.ledger.db.prepare(`SELECT count(*) AS n FROM team_members WHERE team_id=?
        AND (state='member' OR (state='invited' AND expires_at>?))`).get(teamId, Date.now())?.n);
      const pending = Number(this.ledger.db.prepare(`SELECT count(*) AS n FROM team_members m JOIN teams t ON t.id=m.team_id
        WHERE m.actor_id=? AND m.state='invited' AND m.expires_at>? AND t.archived=0`).get(actorId, Date.now())?.n);
      if (occupied >= 128 || pending >= 32) throw new TeamError(409, 'The team or invitation limit is reached.');
      this.ledger.db.prepare(`INSERT INTO team_members(team_id,actor_id,state,invitation,expires_at) VALUES(?,?,'invited',?,?)
        ON CONFLICT(team_id,actor_id) DO UPDATE SET state='invited',generation=generation+1,
        invitation=excluded.invitation,expires_at=excluded.expires_at`).run(teamId, actorId, opaque(), Date.now() + INVITATION_MS);
      this.event(teamId, session, 'invited', actorId);
    });
  }

  respond(session: Session, teamId: string, invitation: string, accept: boolean): void {
    this.ledger.transaction(() => {
      this.actor(session);
      if (!TEAM_ID.test(teamId) || !TEAM_ID.test(invitation)) throw new TeamError(404, 'Invitation unavailable.');
      const row = this.ledger.db.prepare(`SELECT t.creator_id FROM team_members m JOIN teams t ON t.id=m.team_id
        WHERE m.team_id=? AND m.actor_id=? AND m.state='invited' AND m.invitation=? AND m.expires_at>?
        AND t.archived=0`).get(teamId, session.actorId, invitation, Date.now());
      if (!row || !this.accountAvailable(String(row.creator_id))) throw new TeamError(404, 'Invitation unavailable.');
      this.ledger.db.prepare(`UPDATE team_members SET state=?,generation=generation+1,invitation=NULL,expires_at=NULL
        WHERE team_id=? AND actor_id=?`).run(accept ? 'member' : 'removed', teamId, session.actorId);
      this.event(teamId, session, accept ? 'joined' : 'declined', session.actorId);
    });
  }

  remove(session: Session, teamId: string, expected: number, actorId: string): void {
    this.ledger.transaction(() => {
      const team = this.member(session, teamId);
      this.version(team, expected);
      if (actorId === team.creatorId) throw new TeamError(409, 'The creator must archive the team instead of leaving it.');
      if (team.creatorId !== session.actorId && actorId !== session.actorId) throw new TeamError(403, 'Only the team creator can remove another member.');
      const previous = this.ledger.db.prepare(`SELECT state FROM team_members WHERE team_id=? AND actor_id=? AND state!='removed'`).get(teamId, actorId);
      if (!previous) throw new TeamError(404, 'Membership unavailable.');
      this.ledger.db.prepare(`UPDATE team_members SET state='removed',generation=generation+1,invitation=NULL,expires_at=NULL
        WHERE team_id=? AND actor_id=?`).run(teamId, actorId);
      this.event(teamId, session, previous.state === 'invited' ? 'invitation-withdrawn' : actorId === session.actorId ? 'left' : 'removed', actorId);
    });
  }

  archive(session: Session, teamId: string, expected: number): void {
    this.ledger.transaction(() => {
      this.creator(session, teamId, expected);
      this.ledger.db.prepare('UPDATE teams SET archived=1 WHERE id=?').run(teamId);
      this.ledger.db.prepare("UPDATE team_members SET state='removed',generation=generation+1,invitation=NULL,expires_at=NULL WHERE team_id=?").run(teamId);
      this.event(teamId, session, 'archived');
    });
  }

  authority(session: Session, teamId: string): TeamAuthority {
    return this.ledger.transaction(() => {
      const team = this.member(session, teamId);
      return Object.freeze({ session: Object.freeze({ ...session }), teamId, generation: team.generation });
    });
  }

  current(authority: TeamAuthority): boolean {
    try { return this.ledger.transaction(() => this.member(authority.session, authority.teamId).generation === authority.generation); }
    catch (error) { if (error instanceof TeamError) return false; throw error; }
  }

  /** Synchronous resource operations commit with membership in one transaction.
   * The member generation changes on removal/rejoin, independently of renaming
   * the team or inviting another person. Never await inside this callback. */
  withMember<T>(session: Session, teamId: string, operation: (generation: number) => T): T {
    return this.ledger.transaction(() => {
      this.member(session, teamId);
      const row = this.ledger.db.prepare('SELECT generation FROM team_members WHERE team_id=? AND actor_id=?').get(teamId, session.actorId)!;
      return operation(Number(row.generation));
    });
  }
}
