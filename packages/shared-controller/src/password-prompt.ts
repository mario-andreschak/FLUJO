import { emitKeypressEvents, type Key } from 'node:readline';
import { passwordAllowed } from './password.js';

/** Passwords never enter argv, environment, logs or a shell-history command. */
async function hidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) throw new Error('Interactive terminal required.');
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  process.stderr.write(prompt);
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    let overflow = false;
    const finish = (cancel: boolean) => {
      input.off('keypress', keypress); input.off('end', ended); input.off('error', ended);
      input.setRawMode(wasRaw); input.pause();
      process.stderr.write('\n');
      if (cancel || overflow) reject(new Error('Password entry cancelled or too long.'));
      else resolve(value);
      value = '';
    };
    const ended = () => finish(true);
    const keypress = (text: string | undefined, key: Key) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) { finish(true); return; }
      if (key.name === 'return' || key.name === 'enter') { finish(false); return; }
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl && key.name === 'u') { value = ''; overflow = false; return; }
      if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f]/.test(text)) {
        if (Buffer.byteLength(value + text, 'utf8') > 1024) overflow = true;
        else if (!overflow) value += text;
      }
    };
    input.on('keypress', keypress); input.once('end', ended); input.once('error', ended);
  });
}

export async function promptPassword(): Promise<string> {
  process.stderr.write('Use at least 15 characters (maximum 1024 UTF-8 bytes). Input is hidden.\n');
  const first = await hidden('New password: ');
  if (!passwordAllowed(first)) throw new Error('Password does not meet the local policy.');
  if (first !== await hidden('Repeat password: ')) throw new Error('Passwords do not match.');
  return first;
}
