import { StringDecoder } from 'node:string_decoder';
/** Mask URL credentials and parameters in endpoints or native diagnostics. */
export function redactGitMessage(value: string) {
  // Apostrophes can belong to URL userinfo, paths and parameters, even in quoted diagnostics.
  return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"]+/gi, (url) =>
    url
      // Userinfo ends at the last @ in the authority, including unescaped @ in passwords.
      .replace(/^(https?:\/\/)[^/?#]*@/i, '$1[credentials]@')
      .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@?#]*):[^/?#]*@/i, '$1:[redacted]@')
      .replace(/[?#].*$/, '[redacted parameters]'),
  );
}
/** Buffer entire progress lines so a split credential is never emitted unmasked. */
export class GitProgressLines {
  private decoder = new StringDecoder('utf8');
  private line = '';
  private oversized = false;
  constructor(private emit: (text: string) => void) {}
  private consume(text: string) {
    for (const char of text) {
      if (char === '\r' || char === '\n') this.flush();
      else if (!this.oversized) {
        if (this.line.length >= 4096) {
          this.oversized = true;
          this.line = '';
        } else if (char.charCodeAt(0) >= 32 || char === '\t') this.line += char;
      }
    }
  }
  private flush() {
    if (this.oversized) this.emit('Git progress line omitted: too long');
    else if (this.line.trim()) this.emit(redactGitMessage(this.line).slice(0, 4096));
    this.line = '';
    this.oversized = false;
  }
  push(chunk: Buffer) {
    this.consume(this.decoder.write(chunk));
  }
  end() {
    this.consume(this.decoder.end());
    this.flush();
  }
}
