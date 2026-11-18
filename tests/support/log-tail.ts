/**
 * The end of a log that keeps arriving, at most `most` chars of it, so a process that writes for
 * days doesn't grow the one reading it. It trims only once it holds twice that, which keeps each
 * append cheap.
 */
export class LogTail {
  readonly most: number;
  #text = "";
  #dropped = 0;

  constructor(most: number) {
    this.most = most;
  }

  append(chunk: string): void {
    this.#text += chunk;
    if (this.#text.length < 2 * this.most) return;
    this.#dropped += this.#text.length - this.most;
    this.#text = this.#text.slice(-this.most);
  }

  /** What is kept, after a line saying how much came before it, if any did. */
  text(): string {
    return this.#dropped === 0 ? this.#text : `[${this.#dropped} chars before]\n${this.#text}`;
  }
}
