// The test calls in a TypeScript test file, read from its tokens rather than its lines, so neither
// git's diff alignment nor the formatter's layout changes what is found.
//
// TypeScript 7 ships no parser that runs in JavaScript, only this scanner, under an unstable
// path. `typescript` is pinned exactly in package.json, so an upgrade that moves the path fails
// here at load rather than reading no tests.
import { LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";

export type TestCall = {
  /** The title, when the call's first argument is a string or a template without `${}`. */
  title: string | undefined;
  /** The first argument's tokens, which identify a test whose title can't be read. */
  titleTokens: string;
  /** The call's tokens from `it`/`test` to its closing `)`, the title's as a placeholder. */
  body: string;
};

type Token = { kind: SyntaxKind; text: string; value: string };

const TEST_NAMES = new Set(["it", "test"]);

// A comma before one of these is the formatter's, added when it wraps a list.
const CLOSES = new Set([")", "]", "}"]);

const OPENS: ReadonlyMap<SyntaxKind, SyntaxKind> = new Map([
  [SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken],
  [SyntaxKind.OpenBracketToken, SyntaxKind.CloseBracketToken],
  [SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken],
  [SyntaxKind.TemplateHead, SyntaxKind.TemplateTail],
]);

// A `/` after one of these divides; after anything else it starts a regex.
const ENDS_OPERAND = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

const isKeyword = (kind: SyntaxKind) =>
  kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword;

const isName = (kind: SyntaxKind | undefined) =>
  kind !== undefined && (kind === SyntaxKind.Identifier || isKeyword(kind));

function tokenize(source: string): Token[] | string {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: Token[] = [];
  const templates: boolean[] = [];
  for (;;) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) return tokens;
    const before = tokens.at(-1)?.kind;
    const afterDot = tokens.at(-2)?.kind === SyntaxKind.DotToken;
    if (kind === SyntaxKind.OpenBraceToken) templates.push(false);
    else if (kind === SyntaxKind.TemplateHead) templates.push(true);
    else if (kind === SyntaxKind.CloseBraceToken && templates.pop() === true) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateMiddle) templates.push(true);
    } else if (
      (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
      !(before !== undefined && (ENDS_OPERAND.has(before) || (afterDot && isName(before))))
    ) {
      kind = scanner.reScanSlashToken();
    }
    if (scanner.isUnterminated()) {
      return `an unterminated literal at offset ${scanner.getTokenStart()}`;
    }
    if (kind === SyntaxKind.Unknown) {
      return `an unreadable character at offset ${scanner.getTokenStart()}`;
    }
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  }
}

/** For each opening token's index, its closing token's; or why the brackets don't balance. */
function closers(tokens: Token[]): Map<number, number> | string {
  const closing = new Map<number, number>();
  const open: number[] = [];
  for (const [i, { kind }] of tokens.entries()) {
    if (OPENS.has(kind)) {
      open.push(i);
      continue;
    }
    if (kind !== SyntaxKind.TemplateMiddle && ![...OPENS.values()].includes(kind)) continue;
    const at = open.at(-1);
    const opener = at === undefined ? undefined : tokens[at]?.kind;
    const expected = opener === undefined ? undefined : OPENS.get(opener);
    const matches =
      kind === SyntaxKind.TemplateMiddle ? opener === SyntaxKind.TemplateHead : expected === kind;
    if (at === undefined || !matches)
      return `brackets that don't balance (a stray "${tokens[i]?.text}")`;
    if (kind === SyntaxKind.TemplateMiddle) continue;
    open.pop();
    closing.set(at, i);
  }
  return open.length === 0 ? closing : "brackets left open at its end";
}

/**
 * Each test call in `source`: an `it` or `test` that isn't a property or a declaration, then any
 * chain of `.name`, `(...)` and tagged templates, whose last `(...)` takes the title first. So
 * `it.runIf(c)("t", f)`, `it.each(rows)("t %s", f)` and ``it.each`…`("t", f)`` are read in any
 * layout. A last call with no arguments, or followed by `{` or `:` (a method named `test`), is
 * no test. A string that reads like a test call is a string. Returns why instead when the
 * source can't be read: a literal left open, or brackets that don't balance.
 */
export function testCalls(source: string): TestCall[] | string {
  const tokens = tokenize(source);
  if (typeof tokens === "string") return tokens;
  const closing = closers(tokens);
  if (typeof closing === "string") return closing;
  const calls: TestCall[] = [];
  for (const [i, token] of tokens.entries()) {
    const before = tokens[i - 1]?.kind;
    if (
      token.kind !== SyntaxKind.Identifier ||
      !TEST_NAMES.has(token.text) ||
      before === SyntaxKind.DotToken ||
      before === SyntaxKind.QuestionDotToken ||
      before === SyntaxKind.FunctionKeyword
    ) {
      continue;
    }
    let last: { open: number; close: number } | undefined;
    let next = i + 1;
    for (;;) {
      const kind = tokens[next]?.kind;
      if (kind === SyntaxKind.DotToken && isName(tokens[next + 1]?.kind)) next += 2;
      else if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) next += 1;
      else if (kind === SyntaxKind.TemplateHead) next = (closing.get(next) ?? next) + 1;
      else if (kind === SyntaxKind.OpenParenToken) {
        const close = closing.get(next) ?? next;
        last = { open: next, close };
        next = close + 1;
      } else break;
    }
    const after = tokens[next]?.kind;
    if (
      last === undefined ||
      last.close === last.open + 1 ||
      after === SyntaxKind.OpenBraceToken ||
      after === SyntaxKind.ColonToken
    ) {
      continue;
    }
    let end = last.open + 1;
    while (end < last.close && tokens[end]?.kind !== SyntaxKind.CommaToken) {
      end = (closing.get(end) ?? end) + 1;
    }
    const first = tokens.slice(last.open + 1, end);
    const [only] = first;
    const literal =
      first.length === 1 &&
      only !== undefined &&
      (only.kind === SyntaxKind.StringLiteral ||
        only.kind === SyntaxKind.NoSubstitutionTemplateLiteral);
    const texts = tokens
      .slice(i, last.close + 1)
      .map((t, at) => (literal && at === last.open + 1 - i ? "\0" : t.text))
      .filter((text, at, all) => text !== "," || !CLOSES.has(all[at + 1] ?? ""));
    calls.push({
      title: literal ? only.value : undefined,
      titleTokens: JSON.stringify(first.map((t) => t.text)),
      body: JSON.stringify(texts),
    });
  }
  return calls;
}
