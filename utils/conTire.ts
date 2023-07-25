export type NestedArray = true | NestedArray[]
export default function conTire(signals: string[]) {
  const tireList: NestedArray[] = new Array(127)
  let curTire: NestedArray[] = tireList
  signals.forEach((signal) => {
    for (let i = 0, len = signal.length; i < len; i++) {
      if (!curTire[signal.charCodeAt(i)]) {
        curTire[signal.charCodeAt(i)] = new Array(127)
      }
      curTire = curTire[signal.charCodeAt(i)] as NestedArray[]
    }
    curTire[10] = true
    curTire = tireList
  })
  return tireList
}
