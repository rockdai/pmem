const pad = (value: number) => String(value).padStart(2, '0');

export function formatDate(value: string | number) {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatTime(value: number) {
  const date = new Date(value);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':');
}
