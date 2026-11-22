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
