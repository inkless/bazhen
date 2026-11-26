// What crates/bazhen-protocol's js_number is held to: numbers as Node's JSON.stringify writes them.
// `make schema` writes them to packages/protocol/fixtures/numbers/. Each number is given by
// its IEEE 754 bits, since a decimal would be read back through the very rounding under test.
//
// Most are ties: dyadic numbers whose exact decimal is one digit longer than the shortest digits
// that read back, and ends in 5, so those shortest digits sit exactly halfway between two
// candidates. JavaScript rounds those to even, where Rust's float formatting rounds them up.

/** A seeded generator, so every run writes the same numbers. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const bitsOf = (x: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
};

const fromBits = (high: number, low: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, high);
  view.setUint32(4, low);
  return view.getFloat64(0);
};

/** The significant digits of a number's text, without its sign, point or exponent. */
const significant = (text: string) =>
  (text.split("e")[0] ?? "").replace(/[-.]/g, "").replace(/^0+/, "").replace(/0+$/, "");

/**
 * Whether the shortest digits of `x` are a tie: its exact decimal ends in 5, one digit past them.
 * `toPrecision(100)` is exact for every double whose decimal fits in 100 digits.
 */
export function isTie(x: number): boolean {
  if (!Number.isFinite(x) || x === 0) return false;
  const exact = significant(Math.abs(x).toPrecision(100));
  return exact.endsWith("5") && exact.length === significant(String(x)).length + 1;
}

const TIES = 300;
const RANDOM = 1500;

/** Numbers that have tripped up formatters, as JavaScript writes them all. */
const EDGES = [
  0,
  -0,
  1,
  -3,
  0.1,
  12.5,
  1e-6,
  1e-7,
  1.5e-7,
  1e20,
  1e21,
  -2.5e30,
  123_456.789,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
  2 ** 53,
  2 ** 53 + 2,
  // The reviewer's ties, in the ranges usage and activity numbers take.
  20.005_508_422_851_562_5,
  2.688_301_086_425_781_3,
  76.162_506_103_515_63,
];

export function numberFixture(): Record<string, string> {
  const random = mulberry32(0x6a73);
  const ties: number[] = [];
  // Dyadic numbers in 0..100 with up to 2^-40 resolution, which hold most ties a percent can.
  while (ties.length < TIES) {
    const x = Math.floor(random() * 2 ** 47) / 2 ** 40;
    if (isTie(x)) ties.push(x);
  }
  const anyBits: number[] = [];
  while (anyBits.length < RANDOM) {
    const x = fromBits(Math.floor(random() * 2 ** 32), Math.floor(random() * 2 ** 32));
    if (Number.isFinite(x)) anyBits.push(x);
  }
  const cases = [...EDGES, ...ties, ...anyBits].map((x) => ({
    bits: bitsOf(x),
    text: JSON.stringify(x),
    tie: isTie(x),
  }));
  return { "cases.json": `${JSON.stringify(cases, null, 2)}\n` };
}
