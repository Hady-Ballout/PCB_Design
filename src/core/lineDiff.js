export const changedLineIndexes = (previousText, nextText) => {
  const previous = String(previousText || '').split('\n');
  const next = String(nextText || '').split('\n');
  const rows = previous.length + 1;
  const columns = next.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let left = previous.length - 1; left >= 0; left -= 1) {
    for (let right = next.length - 1; right >= 0; right -= 1) {
      table[left][right] = previous[left] === next[right]
        ? table[left + 1][right + 1] + 1
        : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }

  const unchanged = new Set();
  let left = 0;
  let right = 0;
  while (left < previous.length && right < next.length) {
    if (previous[left] === next[right]) {
      unchanged.add(right);
      left += 1;
      right += 1;
    } else if (table[left + 1][right] >= table[left][right + 1]) {
      left += 1;
    } else {
      right += 1;
    }
  }

  return new Set(next.map((_, index) => index).filter((index) => !unchanged.has(index)));
};
