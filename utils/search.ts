export function binarySearch(arr: number[], num: number) {
  let left = 0,
    right = arr.length - 1
  for (; left <= right; ) {
    const mid = Math.floor((left + right) / 2)
    if (arr[mid] < num) {
      left = mid + 1
    } else if (arr[mid] > num) {
      right = mid - 1
    } else return mid
  }
  return left
}
