export function createDayFormatter(timeZone) {
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });

  return (instant) => {
    const fields = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
    return `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day}`;
  };
}

export const oneDay = 86_400_000;

export function dateMillis(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

export function offsetDay(date, offset) {
  return new Date(dateMillis(date) + offset * oneDay).toISOString().slice(0, 10);
}
