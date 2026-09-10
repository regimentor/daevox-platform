/** Parsed numeric calendar fields. / Разобранные числовые поля календаря. @private */
export interface ScheduledCron {
  /** Ordered seconds through weekdays. / Упорядоченные секунды–дни недели. @private */
  readonly fields: readonly number[][];
  /** Unrestricted day of month. / Неограниченный день месяца. @private */
  readonly anyDay: boolean;
  /** Unrestricted weekday. / Неограниченный день недели. @private */
  readonly anyWeekday: boolean;
}

/** Parse one numeric field. / Разбирает одно числовое поле. @private */
function parseField(field: string, minimum: number, maximum: number): number[] {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new TypeError('Invalid cron field');
    const step = match[2] === undefined ? 1 : Number(match[2]);
    const range = match[1].split('-').map(Number);
    const start = match[1] === '*' ? minimum : range[0];
    const end =
      match[1] === '*' ? maximum : (range[1] ?? (match[2] === undefined ? start : maximum));
    if (
      !Number.isSafeInteger(step) ||
      step <= 0 ||
      start < minimum ||
      end > maximum ||
      start > end
    ) {
      throw new TypeError('Invalid cron range or step');
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].toSorted((a, b) => a - b);
}

/** Check calendar-day OR semantics. / Проверяет календарный день с семантикой ИЛИ. @private */
export function matchesScheduledDay(cron: ScheduledCron, date: Date): boolean {
  const day = cron.fields[3].includes(date.getUTCDate());
  const weekday = cron.fields[5].includes(date.getUTCDay());
  return cron.anyDay ? weekday : cron.anyWeekday ? day : day || weekday;
}

/** Validate a six-field schedule before publication. / Проверяет шестипольное расписание до публикации. @private */
export function parseScheduledCron(value: unknown): ScheduledCron {
  if (typeof value !== 'string') throw new TypeError('cron must be a string');
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 6) throw new TypeError('cron requires six fields');
  const limits = [
    [0, 59],
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  const fields = parts.map((part, index) => parseField(part, limits[index][0], limits[index][1]));
  fields[5] = [...new Set(fields[5].map((weekday) => weekday % 7))];
  const cron = { fields, anyDay: parts[3] === '*', anyWeekday: parts[5] === '*' };
  // A leap year contains every possible month/day combination.
  // Високосный год содержит все возможные сочетания месяца и дня.
  if (
    cron.anyWeekday &&
    !fields[4].some((month) =>
      fields[3].some((day) => new Date(Date.UTC(2000, month - 1, day)).getUTCMonth() === month - 1),
    )
  ) {
    throw new TypeError('cron has no possible calendar date');
  }
  return cron;
}

/** Calendar wall time expressed as UTC for arithmetic. / Местное время как UTC для арифметики. @private */
function wallTime(time: number, zone: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(zone.formatToParts(time).map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/** Find the next absolute instant, preserving repeated local times. / Находит следующий абсолютный момент, сохраняя повторы местного времени. @private */
export function nextScheduledTime(
  cron: ScheduledCron,
  after: number,
  zone: Intl.DateTimeFormat,
): number {
  const local = new Date(wallTime(after, zone));
  local.setUTCHours(0, 0, 0, 0);
  for (;;) {
    const midnight = local.getTime();
    if (cron.fields[4].includes(local.getUTCMonth() + 1) && matchesScheduledDay(cron, local)) {
      const offsets = new Set(
        [-86400000, 0, 86400000].map(
          (delta) => wallTime(midnight + delta, zone) - (midnight + delta),
        ),
      );
      let best = Infinity;
      for (const offset of offsets) {
        const lower = Math.max(0, Math.floor((after + offset - midnight) / 1000) + 1);
        search: for (const hour of cron.fields[2]) {
          if ((hour + 1) * 3600 <= lower) continue;
          for (const minute of cron.fields[1]) {
            if (hour * 3600 + (minute + 1) * 60 <= lower) continue;
            for (const second of cron.fields[0]) {
              const seconds = hour * 3600 + minute * 60 + second;
              if (seconds < lower) continue;
              const candidate = midnight + seconds * 1000 - offset;
              if (wallTime(candidate, zone) !== midnight + seconds * 1000) continue;
              best = Math.min(best, candidate);
              break search;
            }
          }
        }
      }
      if (best !== Infinity) return best;
    }
    local.setUTCDate(local.getUTCDate() + 1);
  }
}
