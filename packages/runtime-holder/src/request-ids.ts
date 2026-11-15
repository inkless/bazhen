const U32_MAX = 0xffff_ffff;

/** The id after `previous`: a u32, wrapping past its maximum, and none `taken` still waits on. */
export function nextRequestId(previous: number, taken: (id: number) => boolean): number {
  let id = previous;
  do id = id >= U32_MAX ? 0 : id + 1;
  while (taken(id));
  return id;
}
