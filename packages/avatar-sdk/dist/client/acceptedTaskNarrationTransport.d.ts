import { type NativeVoiceTransport } from './nativeVoiceTransport';
import type { Locale } from './locale';
/** Host opt-in after qualification. This descriptor is not a server grant.
 * The callback owns the authenticated route and captured session; revision is public. */
export interface AcceptedTaskNarrationBinding {
    readonly revision: string;
    readonly selectedTaskId: () => string | null;
    readonly postNarration: (init: RequestInit) => Promise<Response>;
}
export interface AcceptedTaskNarrationSelection {
    readonly taskId: string;
    readonly locale: Locale;
}
/** Separate, disabled-by-default adapter. Never installs a route or enables voice.
 * The host validates selected-task membership and all grants again at the server.
 * Responses and cancellation remain owned by the injected authenticated callback. */
export declare function createAcceptedTaskNarrationTransport(base: NativeVoiceTransport, binding?: AcceptedTaskNarrationBinding): NativeVoiceTransport;
