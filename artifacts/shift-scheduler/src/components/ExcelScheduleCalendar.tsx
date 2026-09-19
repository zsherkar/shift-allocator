import { forwardRef } from "react";
import { format, parseISO } from "date-fns";
import { formatAllocationDisplayName } from "@/lib/allocationDisplay";

interface AllocatedShift {
  shiftId: number;
  stableShiftKey?: string;
  slotIndex?: number;
  date: string;
  label: string;
  durationHours: number;
  dayType: "weekday" | "weekend";
  startTime?: string;
  endTime?: string;
  assignmentSource: string;
}

interface AllocationEntry {
  respondentId: number;
  name: string;
  category: "AFP" | "General";
  allocatedShifts: AllocatedShift[];
  totalHours: number;
}

interface ScheduleCalendarProps {
  title: string;
  month: number;
  year: number;
  allocations: AllocationEntry[];
  shifts: Array<{
    id: number;
    date: string;
    dayType: string;
    startTime: string;
    endTime: string;
    durationHours: number;
    label: string;
    stableShiftKey?: string;
    slotIndex?: number;
  }>;
}

type CalendarWeek = {
  weekNum: number;
  weekdays: Array<string | null>;
  weekends: Array<string | null>;
};

const WEEKDAY_SLOTS = [
  { startTime: "09:00", label: "9am - 11am", duration: "2 hours" },
  { startTime: "11:00", label: "11am - 2pm", duration: "3 hours" },
  { startTime: "14:00", label: "2pm - 5pm", duration: "3 hours" },
  { startTime: "17:00", label: "5pm - 8pm", duration: "3 hours" },
];

const WEEKEND_SLOTS = [
  { startTime: "08:00", label: "8 am - 12 pm", duration: "4 hours" },
  { startTime: "12:00", label: "12 pm - 4 pm", duration: "4 hours" },
  { startTime: "16:00", label: "4 pm - 8 pm", duration: "4 hours" },
];

const WEEKDAY_NAMES = ["Mon", "Tues", "Wed", "Thurs", "Fri"];
const WEEKEND_NAMES = ["Sat", "Sun"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const PALETTE = {
  week: "#9dc3e6",
  date: "#70ad47",
  day: "#f4b183",
  border: "#3f3f3f",
  red: "#c00000",
  ink: "#111111",
  white: "#ffffff",
};

const TITLE_FONT = "'Segoe UI', Calibri, Arial, sans-serif";
const BODY_FONT = "Calibri, 'Segoe UI', Arial, sans-serif";

function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getCalendarWeeks(year: number, month: number): CalendarWeek[] {
  const monthIndex = month - 1;
  const first = new Date(year, monthIndex, 1);
  const last = new Date(year, month, 0);
  const cursor = new Date(first);
  const firstMondayOffset = (cursor.getDay() + 6) % 7;
  cursor.setDate(cursor.getDate() - firstMondayOffset);

  const end = new Date(last);
  const lastSundayOffset = 6 - ((end.getDay() + 6) % 7);
  end.setDate(end.getDate() + lastSundayOffset);

  const weeks: CalendarWeek[] = [];
  let weekNum = 1;
  while (cursor <= end) {
    const weekdays: Array<string | null> = [];
    const weekends: Array<string | null> = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(cursor);
      date.setDate(cursor.getDate() + offset);
      const value = date.getMonth() === monthIndex ? toDateString(date) : null;
      if (offset < 5) weekdays.push(value);
      else weekends.push(value);
    }
    weeks.push({ weekNum, weekdays, weekends });
    cursor.setDate(cursor.getDate() + 7);
    weekNum += 1;
  }
  return weeks;
}

function formatDateHeader(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = parseISO(dateStr);
  return `${date.getDate()}-${format(date, "MMM")}`;
}

function getPerson(personMap: Map<string, string>, date: string | null, startTime: string): string {
  return date ? personMap.get(`${date}|${startTime}`) ?? "" : "";
}

function getStableShiftKey(shift: { date: string; startTime: string; endTime: string; slotIndex?: number }) {
  return `${shift.date}|${shift.startTime}|${shift.endTime}|${shift.slotIndex ?? 0}`;
}

function getSlotIndexes(shifts: ScheduleCalendarProps["shifts"]) {
  const byDate = new Map<string, ScheduleCalendarProps["shifts"]>();
  for (const shift of shifts) {
    byDate.set(shift.date, [...(byDate.get(shift.date) ?? []), shift]);
  }

  const slotIndexes = new Map<number, number>();
  for (const shiftsForDate of byDate.values()) {
    shiftsForDate
      .sort(
        (a, b) =>
          a.startTime.localeCompare(b.startTime) ||
          a.endTime.localeCompare(b.endTime) ||
          a.id - b.id,
      )
      .forEach((shift, index) => slotIndexes.set(shift.id, index));
  }
  return slotIndexes;
}

const scheduleWidth = 1252;

const baseCellStyle: React.CSSProperties = {
  border: `1.25px solid ${PALETTE.border}`,
  color: PALETTE.ink,
  backgroundColor: PALETTE.white,
  boxSizing: "border-box",
  height: 44,
  padding: 0,
  textAlign: "center",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
  overflow: "hidden",
  fontSize: 16,
  lineHeight: "1.3",
};

const titleCellStyle: React.CSSProperties = {
  ...baseCellStyle,
  fontFamily: TITLE_FONT,
  fontSize: 16,
};

const nameCellStyle: React.CSSProperties = {
  ...baseCellStyle,
  fontFamily: BODY_FONT,
  fontSize: 17,
  fontWeight: 600,
};

const categoryCellStyle: React.CSSProperties = {
  ...titleCellStyle,
  color: "#ff0000",
  fontStyle: "italic",
  fontWeight: 700,
  height: 38,
  backgroundColor: PALETTE.white,
};

const weekCellStyle: React.CSSProperties = {
  ...titleCellStyle,
  backgroundColor: PALETTE.week,
  fontWeight: 700,
  height: 40,
};

const dateCellStyle: React.CSSProperties = {
  ...titleCellStyle,
  backgroundColor: PALETTE.date,
  fontWeight: 500,
};

const dayCellStyle: React.CSSProperties = {
  ...titleCellStyle,
  backgroundColor: PALETTE.day,
  fontWeight: 700,
};

const sideHeaderStyle: React.CSSProperties = {
  ...titleCellStyle,
  color: PALETTE.red,
  fontWeight: 400,
};

const bodyLabelStyle: React.CSSProperties = {
  ...titleCellStyle,
  fontFamily: BODY_FONT,
  fontSize: 15.5,
};

function getCellContentStyle(
  cellStyle: React.CSSProperties,
  overrides?: React.CSSProperties,
): React.CSSProperties {
  const minHeight =
    typeof cellStyle.height === "number"
      ? `${cellStyle.height}px`
      : typeof cellStyle.height === "string"
        ? cellStyle.height
        : undefined;

  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    minHeight,
    padding: "6px 10px",
    boxSizing: "border-box",
    textAlign: "center",
    ...overrides,
  };
}

function renderCellText(
  value: string | null | undefined,
  cellStyle: React.CSSProperties,
  overrides?: React.CSSProperties,
) {
  return (
    <div style={getCellContentStyle(cellStyle, overrides)}>
      {value?.trim() ? value : "\u00A0"}
    </div>
  );
}

export const ExcelScheduleCalendar = forwardRef<HTMLDivElement, ScheduleCalendarProps>(
  ({ month, year, allocations, shifts }, ref) => {
    const personMap = new Map<string, string>();
    const legacyPersonMap = new Map<string, string>();
    const shiftInfoMap = new Map(shifts.map((shift) => [shift.id, shift]));
    const slotIndexes = getSlotIndexes(shifts);
    const stableKeyByShiftId = new Map(
      shifts.map((shift) => {
        const slotIndex = shift.slotIndex ?? slotIndexes.get(shift.id) ?? 0;
        return [shift.id, shift.stableShiftKey ?? getStableShiftKey({ ...shift, slotIndex })] as const;
      }),
    );
    const shiftByDateStart = new Map(shifts.map((shift) => [`${shift.date}|${shift.startTime}`, shift] as const));

    for (const entry of allocations) {
      for (const shift of entry.allocatedShifts) {
        const startTime = shift.startTime ?? shiftInfoMap.get(shift.shiftId)?.startTime;
        if (!startTime) continue;
        const displayName = formatAllocationDisplayName(entry.name, shift.assignmentSource);
        const stableKey = shift.stableShiftKey ?? stableKeyByShiftId.get(shift.shiftId);
        if (stableKey) personMap.set(stableKey, displayName);
        legacyPersonMap.set(`${shift.date}|${startTime}`, displayName);
      }
    }

    const getRenderedPerson = (date: string | null, startTime: string) => {
      if (!date) return "";
      const shift = shiftByDateStart.get(`${date}|${startTime}`);
      if (shift) {
        const stableKey = stableKeyByShiftId.get(shift.id);
        if (stableKey && personMap.has(stableKey)) return personMap.get(stableKey) ?? "";
      }
      return getPerson(legacyPersonMap, date, startTime);
    };

    const weeks = getCalendarWeeks(year, month);

    return (
      <div
        ref={ref}
        style={{
          width: scheduleWidth,
          backgroundColor: PALETTE.white,
          color: PALETTE.ink,
          padding: "10px 0 16px",
          fontFamily: BODY_FONT,
          boxSizing: "border-box",
        }}
      >
        <h2
          style={{
            margin: "0 0 14px",
            textAlign: "center",
            textDecoration: "underline",
            fontFamily: TITLE_FONT,
            fontSize: 32,
            lineHeight: "40px",
            fontWeight: 700,
          }}
        >
          Front Desk Schedule: {MONTH_NAMES[month - 1]} {year}
        </h2>
        <p
          style={{
            margin: "0 0 12px",
            textAlign: "center",
            fontSize: 13,
            lineHeight: "18px",
            color: PALETTE.ink,
          }}
        >
          * AFP assigned to a shift with no submitted availability.
        </p>

        {weeks.map((week) => (
          <table
            key={week.weekNum}
            style={{
              width: "100%",
              tableLayout: "fixed",
              borderCollapse: "collapse",
              marginBottom: 16,
            }}
          >
            <colgroup>
              <col style={{ width: 126 }} />
              <col style={{ width: 150 }} />
              {WEEKDAY_NAMES.map((day) => (
                <col key={day} style={{ width: 100 }} />
              ))}
              <col style={{ width: 126 }} />
              <col style={{ width: 150 }} />
              {WEEKEND_NAMES.map((day) => (
                <col key={day} style={{ width: 100 }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <td colSpan={11} style={weekCellStyle}>
                  {renderCellText(`Week ${week.weekNum}`, weekCellStyle)}
                </td>
              </tr>
              <tr>
                <td colSpan={2} style={{ ...titleCellStyle, borderBottom: 0 }} />
                <td colSpan={5} style={categoryCellStyle}>
                  {renderCellText("Weekday", categoryCellStyle)}
                </td>
                <td colSpan={4} style={categoryCellStyle}>
                  {renderCellText("Weekend", categoryCellStyle)}
                </td>
              </tr>
              <tr>
                <td rowSpan={2} style={sideHeaderStyle}>
                  {renderCellText("Time", sideHeaderStyle)}
                </td>
                <td rowSpan={2} style={sideHeaderStyle}>
                  {renderCellText("Duration per shift", sideHeaderStyle)}
                </td>
                {week.weekdays.map((date, index) => (
                  <td key={`weekday-date-${index}`} style={dateCellStyle}>
                    {renderCellText(formatDateHeader(date), dateCellStyle)}
                  </td>
                ))}
                <td rowSpan={2} style={sideHeaderStyle}>
                  {renderCellText("Time", sideHeaderStyle)}
                </td>
                <td rowSpan={2} style={sideHeaderStyle}>
                  {renderCellText("Duration per shift", sideHeaderStyle)}
                </td>
                {week.weekends.map((date, index) => (
                  <td key={`weekend-date-${index}`} style={dateCellStyle}>
                    {renderCellText(formatDateHeader(date), dateCellStyle)}
                  </td>
                ))}
              </tr>
              <tr>
                {WEEKDAY_NAMES.map((day) => (
                  <td key={day} style={dayCellStyle}>
                    {renderCellText(day, dayCellStyle)}
                  </td>
                ))}
                {WEEKEND_NAMES.map((day) => (
                  <td key={day} style={dayCellStyle}>
                    {renderCellText(day, dayCellStyle)}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEKDAY_SLOTS.map((slot, index) => {
                const weekendSlot = WEEKEND_SLOTS[index] ?? null;
                return (
                  <tr key={slot.startTime}>
                    <td style={bodyLabelStyle}>
                      {renderCellText(slot.label, bodyLabelStyle)}
                    </td>
                    <td style={bodyLabelStyle}>
                      {renderCellText(slot.duration, bodyLabelStyle)}
                    </td>
                    {week.weekdays.map((date, dayIndex) => (
                      <td key={`weekday-person-${dayIndex}`} style={nameCellStyle}>
                        {renderCellText(
                          getRenderedPerson(date, slot.startTime),
                          nameCellStyle,
                        )}
                      </td>
                    ))}
                    <td style={bodyLabelStyle}>
                      {renderCellText(weekendSlot?.label ?? "", bodyLabelStyle)}
                    </td>
                    <td style={bodyLabelStyle}>
                      {renderCellText(weekendSlot?.duration ?? "", bodyLabelStyle)}
                    </td>
                    {week.weekends.map((date, dayIndex) => (
                      <td key={`weekend-person-${dayIndex}`} style={nameCellStyle}>
                        {renderCellText(
                          weekendSlot
                            ? getRenderedPerson(date, weekendSlot.startTime)
                            : "",
                          nameCellStyle,
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
      </div>
    );
  },
);

ExcelScheduleCalendar.displayName = "ExcelScheduleCalendar";
