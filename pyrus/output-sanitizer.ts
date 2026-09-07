import { StringDecoder } from "node:string_decoder";

export class OutputSanitizer {
  decoder: StringDecoder;
  state: string;
  previousWasCarriageReturn: boolean;

  constructor() {
    this.decoder = new StringDecoder("utf8");
    this.state = "text";
    this.previousWasCarriageReturn = false;
  }

  write(buffer: Uint8Array): string {
    return this.sanitize(this.decoder.write(buffer));
  }

  end(): string {
    return this.sanitize(this.decoder.end());
  }

  sanitize(text: string): string {
    let clean = "";
    for (const character of text) {
      const code = character.codePointAt(0)!;
      if (this.previousWasCarriageReturn) {
        this.previousWasCarriageReturn = false;
        if (code === 0x0a) continue;
      }
      if (this.state === "osc" || this.state === "string") {
        if (code === 0x07) this.state = "text";
        else if (code === 0x1b) this.state = `${this.state}-escape`;
        continue;
      }
      if (this.state === "osc-escape" || this.state === "string-escape") {
        this.state = code === 0x5c ? "text" : this.state.replace("-escape", "");
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (this.state === "escape") {
        if (code === 0x5b) this.state = "csi";
        else if (code === 0x5d) this.state = "osc";
        else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) this.state = "string";
        else if (code >= 0x20 && code <= 0x2f) this.state = "escape-intermediate";
        else this.state = "text";
        continue;
      }
      if (this.state === "escape-intermediate") {
        if (code >= 0x30 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (code === 0x1b) {
        this.state = "escape";
      } else if (code === 0x9b) {
        this.state = "csi";
      } else if (code === 0x9d) {
        this.state = "osc";
      } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        this.state = "string";
      } else if (code === 0x0d) {
        clean += "\n";
        this.previousWasCarriageReturn = true;
      } else if (
        code === 0x09
        || code === 0x0a
        || (code >= 0x20
          && !(code >= 0x7f && code <= 0x9f)
          && !(code >= 0x202a && code <= 0x202e)
          && !(code >= 0x2066 && code <= 0x2069)
          && code !== 0xfeff)
      ) {
        clean += character;
      }
    }
    return clean;
  }
}

export function sanitizeOutput(bytes: Uint8Array): string {
  const sanitizer = new OutputSanitizer();
  const split = Math.floor(bytes.length / 2);
  return sanitizer.write(bytes.slice(0, split))
    + sanitizer.write(bytes.slice(split))
    + sanitizer.end();
}
