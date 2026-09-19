import ExcelJS from "exceljs";
import type { Borders, Fill, Style } from "exceljs";
import { format, parseISO } from "date-fns";
import {
  formatAllocationDisplayName,
  isNoAvailabilityPlaceholderSource,
} from "./allocationDisplay";

export type CalendarSurvey = {
  title?: string | null;
  month: number;
  year: number;
  shifts: Array<{
    id: number;
    date: string;
    dayType: string;
    startTime: string;
    endTime: string;
    durationHours: number;
    label: string;
  }>;
};

export type CalendarAllocation = {
  respondentId: number;
  name: string;
  category: "AFP" | "General";
  totalHours: number;
  allocatedShifts: Array<{
    shiftId: number;
    stableShiftKey?: string;
    date: string;
    label: string;
    startTime: string;
    endTime: string;
    durationHours: number;
    dayType: "weekday" | "weekend";
    assignmentSource: string;
    isManual: boolean;
    isEmergency: boolean;
    explanationCodes: string[];
  }>;
};

export type CalendarResponse = {
  respondentId: number;
  email?: string | null;
};

export type CalendarBlankShift = {
  shiftId: number;
  date: string;
  startTime: string;
  endTime: string;
  durationHours: number;
  availabilityCount: number;
  reasonCategory: string;
  explanationText: string;
};

export type CalendarAuditRow = {
  shiftId: number;
  stableShiftKey: string;
  date: string;
  startTime: string;
  endTime: string;
  assignedRespondentName: string | null;
  availabilityCount: number;
  reasonCategory: string;
};

export type CalendarAllocationStat = {
  name: string;
  category: "AFP" | "General";
  totalHours: number;
  shiftCount: number;
  targetHours?: number;
  deviationFromTargetHours?: number;
  noAvailabilityPlaceholderHours?: number;
};

export type CalendarStats = {
  respondentStats?: CalendarAllocationStat[];
  afpStats?: CalendarAllocationStat[];
  nonPenalizedGeneralMeanHours?: number;
  nonPenalizedGeneralStdDevHours?: number;
  fairnessTargetStdDevHours?: number;
  fairnessWarningStdDevHours?: number;
  fairnessRepairAttempted?: boolean;
  fairnessRepairMoveCount?: number;
  fairnessHighStdDevReason?: string;
};

export type BuildCalendarWorkbookInput = {
  survey: CalendarSurvey;
  allocations: CalendarAllocation[];
  responses?: CalendarResponse[];
  blankShiftExplanations?: CalendarBlankShift[];
  allocationAudit?: CalendarAuditRow[];
  allocStats?: CalendarStats | null;
};

function formatTime12(time: string) {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

function formatShiftLabelText(label: string) {
  if (/\b(?:AM|PM)\b/i.test(label)) return label;
  return label.replace(/\b(\d{1,2}:\d{2})\b/g, (match) => formatTime12(match));
}

export async function buildCalendarWorkbook({
  survey,
  allocations,
  responses = [],
  blankShiftExplanations = [],
  allocationAudit = [],
  allocStats,
}: BuildCalendarWorkbookInput): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ISH Front Desk Allocator";
  workbook.created = new Date();
  workbook.views = [{ activeTab: 0, firstSheet: 0, visibility: "visible", x: 0, y: 0, width: 12000, height: 8000 }];

  const respondentById = new Map(responses.map((response) => [response.respondentId, response]));
  const allocationByShiftId = new Map<
    number,
    { name: string; email: string; category: string; source: string; displayName: string }
  >();
  for (const allocation of allocations) {
    const respondent = respondentById.get(allocation.respondentId);
    for (const shift of allocation.allocatedShifts) {
      allocationByShiftId.set(shift.shiftId, {
        name: allocation.name,
        displayName: formatAllocationDisplayName(allocation.name, shift.assignmentSource),
        email: respondent?.email ?? "",
        category: allocation.category,
        source: shift.assignmentSource,
      });
    }
  }

  const nameByDateAndStart = new Map<string, { text: string; source: string }>();
  for (const shift of survey.shifts) {
    const allocation = allocationByShiftId.get(shift.id);
    if (allocation) {
      nameByDateAndStart.set(`${shift.date}|${shift.startTime}`, {
        text: allocation.displayName,
        source: allocation.source,
      });
    }
  }

  const sheet = workbook.addWorksheet("Calendar", {
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      horizontalCentered: true,
    },
    views: [{ showGridLines: false }],
  });
  sheet.properties.defaultRowHeight = 24;
  sheet.columns = [
    { width: 16 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 },
    { width: 18 }, { width: 3 }, { width: 16 }, { width: 16 }, { width: 18 }, { width: 18 },
  ];

  const monthIndex = survey.month - 1;
  const year = survey.year;
  const monthStart = new Date(year, monthIndex, 1);
  const monthEnd = new Date(year, monthIndex + 1, 0);
  const start = new Date(monthStart);
  start.setDate(monthStart.getDate() - ((monthStart.getDay() + 6) % 7));
  const end = new Date(monthEnd);
  end.setDate(monthEnd.getDate() + (7 - end.getDay()) % 7);
  const toYmd = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const dayName = (date: Date) => format(date, "EEE");
  const dateLabel = (date: Date) => (date.getMonth() === monthIndex ? format(date, "MMM d") : "");
  const assigned = (date: Date, startTime: string) => nameByDateAndStart.get(`${toYmd(date)}|${startTime}`);

  const border = {
    top: { style: "thin", color: { argb: "FFCBD5E1" } },
    left: { style: "thin", color: { argb: "FFCBD5E1" } },
    bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
    right: { style: "thin", color: { argb: "FFCBD5E1" } },
  } satisfies Partial<Borders>;
  const fill = (argb: string) => ({ type: "pattern", pattern: "solid", fgColor: { argb } }) as Fill;
  const styleRange = (rowNumber: number, from: number, to: number, style: Partial<Style>) => {
    for (let col = from; col <= to; col += 1) Object.assign(sheet.getRow(rowNumber).getCell(col), style);
  };
  const setCell = (rowNumber: number, colNumber: number, value: string | number, style: Partial<Style> = {}) => {
    const cell = sheet.getRow(rowNumber).getCell(colNumber);
    cell.value = value;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = border;
    Object.assign(cell, style);
    return cell;
  };

  sheet.mergeCells("A1:L1");
  setCell(1, 1, `Front Desk Schedule: ${format(monthStart, "MMMM yyyy")}`, {
    font: { bold: true, size: 16, color: { argb: "FF0F172A" } },
    fill: fill("FFE0F2FE"),
  });
  sheet.getRow(1).height = 32;
  sheet.mergeCells("A2:L2");
  setCell(2, 1, "* No one submitted availability; AFP assigned as emergency placeholder.", {
    font: { italic: true, color: { argb: "FF4338CA" } },
    fill: fill("FFF8FAFC"),
  });

  const weekdaySlots = [
    { label: "9am - 11am", start: "09:00", duration: "2 hours" },
    { label: "11am - 2pm", start: "11:00", duration: "3 hours" },
    { label: "2pm - 5pm", start: "14:00", duration: "3 hours" },
    { label: "5pm - 8pm", start: "17:00", duration: "3 hours" },
  ];
  const weekendSlots = [
    { label: "8am - 12pm", start: "08:00", duration: "4 hours" },
    { label: "12pm - 4pm", start: "12:00", duration: "4 hours" },
    { label: "4pm - 8pm", start: "16:00", duration: "4 hours" },
    { label: "", start: "", duration: "" },
  ];

  let row = 4;
  let weekNumber = 1;
  for (let weekStart = new Date(start); weekStart <= end; weekStart.setDate(weekStart.getDate() + 7)) {
    const dates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + index);
      return date;
    });

    sheet.mergeCells(row, 1, row, 12);
    setCell(row, 1, `Week ${weekNumber}`, {
      font: { bold: true, color: { argb: "FFFFFFFF" } },
      fill: fill("FF2563EB"),
    });
    row += 1;

    sheet.mergeCells(row, 1, row, 7);
    sheet.mergeCells(row, 9, row, 12);
    setCell(row, 1, "Weekday", { font: { bold: true, italic: true, color: { argb: "FFB91C1C" } }, fill: fill("FFFFE4E6") });
    setCell(row, 9, "Weekend", { font: { bold: true, italic: true, color: { argb: "FFB91C1C" } }, fill: fill("FFFFE4E6") });
    styleRange(row, 1, 7, { border });
    styleRange(row, 9, 12, { border });
    row += 1;

    setCell(row, 1, "Date", { fill: fill("FFDCFCE7"), font: { bold: true } });
    setCell(row, 2, "", { fill: fill("FFDCFCE7") });
    dates.slice(0, 5).forEach((date, index) =>
      setCell(row, 3 + index, dateLabel(date), { fill: fill("FFDCFCE7"), font: { bold: true } }),
    );
    setCell(row, 9, "Date", { fill: fill("FFDCFCE7"), font: { bold: true } });
    setCell(row, 10, "", { fill: fill("FFDCFCE7") });
    dates.slice(5).forEach((date, index) =>
      setCell(row, 11 + index, dateLabel(date), { fill: fill("FFDCFCE7"), font: { bold: true } }),
    );
    row += 1;

    setCell(row, 1, "Time", { fill: fill("FFFFEDD5"), font: { bold: true } });
    setCell(row, 2, "Duration per shift", { fill: fill("FFFFEDD5"), font: { bold: true } });
    dates.slice(0, 5).forEach((date, index) =>
      setCell(row, 3 + index, dayName(date), { fill: fill("FFFFEDD5"), font: { bold: true } }),
    );
    setCell(row, 9, "Time", { fill: fill("FFFFEDD5"), font: { bold: true } });
    setCell(row, 10, "Duration per shift", { fill: fill("FFFFEDD5"), font: { bold: true } });
    dates.slice(5).forEach((date, index) =>
      setCell(row, 11 + index, dayName(date), { fill: fill("FFFFEDD5"), font: { bold: true } }),
    );
    row += 1;

    for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
      const weekdaySlot = weekdaySlots[slotIndex];
      const weekendSlot = weekendSlots[slotIndex];
      setCell(row, 1, weekdaySlot.label);
      setCell(row, 2, weekdaySlot.duration);
      dates.slice(0, 5).forEach((date, index) => {
        const inMonth = date.getMonth() === monthIndex;
        const match = inMonth ? assigned(date, weekdaySlot.start) : undefined;
        const cell = setCell(row, 3 + index, match?.text ?? "");
        cell.font = { bold: Boolean(cell.value), color: { argb: "FF0F172A" } };
        if (match && isNoAvailabilityPlaceholderSource(match.source)) {
          cell.note = "No one selected this shift. AFP assigned as no-availability emergency placeholder.";
        }
      });
      setCell(row, 9, weekendSlot.label);
      setCell(row, 10, weekendSlot.duration);
      dates.slice(5).forEach((date, index) => {
        const inMonth = date.getMonth() === monthIndex && weekendSlot.start;
        const match = inMonth ? assigned(date, weekendSlot.start) : undefined;
        const cell = setCell(row, 11 + index, match?.text ?? "");
        cell.font = { bold: Boolean(cell.value), color: { argb: "FF0F172A" } };
        if (match && isNoAvailabilityPlaceholderSource(match.source)) {
          cell.note = "No one selected this shift. AFP assigned as no-availability emergency placeholder.";
        }
      });
      row += 1;
    }

    row += 1;
    weekNumber += 1;
  }

  sheet.pageSetup.printArea = `A1:L${row}`;

  const scheduleSheet = workbook.addWorksheet("Schedule List");
  scheduleSheet.addRow([
    "date", "day_of_week", "shift_label", "start_time", "end_time", "duration_hours",
    "assigned_name", "assigned_email", "assigned_category", "assignment_source", "is_blank",
  ]);
  for (const shift of [...survey.shifts].sort((a, b) => `${a.date}-${a.startTime}`.localeCompare(`${b.date}-${b.startTime}`))) {
    const allocation = allocationByShiftId.get(shift.id);
    scheduleSheet.addRow([
      shift.date,
      format(parseISO(shift.date), "EEEE"),
      formatShiftLabelText(shift.label),
      formatTime12(shift.startTime),
      formatTime12(shift.endTime),
      shift.durationHours,
      allocation?.displayName ?? "",
      allocation?.email ?? "",
      allocation?.category ?? "",
      allocation?.source ?? "blank",
      allocation ? "no" : "yes",
    ]);
  }

  const personSheet = workbook.addWorksheet("Person Summary");
  personSheet.addRow(["name", "category", "total_hours", "shift_count", "target_hours", "deviation_from_target", "no_availability_placeholder_hours"]);
  for (const stat of allocStats?.respondentStats ?? []) {
    personSheet.addRow([
      stat.name,
      stat.category,
      stat.totalHours,
      stat.shiftCount,
      stat.targetHours ?? "",
      stat.deviationFromTargetHours ?? "",
      stat.noAvailabilityPlaceholderHours ?? 0,
    ]);
  }

  const blankSheet = workbook.addWorksheet("Blank Shifts");
  blankSheet.addRow(["date", "shift", "availability_count", "reason", "explanation"]);
  for (const blank of blankShiftExplanations) {
    blankSheet.addRow([
      blank.date,
      `${formatTime12(blank.startTime)}-${formatTime12(blank.endTime)}`,
      blank.availabilityCount,
      blank.reasonCategory,
      blank.explanationText,
    ]);
  }

  const fairnessSheet = workbook.addWorksheet("Fairness Stats");
  fairnessSheet.addRows([
    ["metric", "value"],
    ["non_penalized_general_mean_hours", allocStats?.nonPenalizedGeneralMeanHours ?? ""],
    ["non_penalized_general_std_dev_hours", allocStats?.nonPenalizedGeneralStdDevHours ?? ""],
    ["target_std_dev_hours", allocStats?.fairnessTargetStdDevHours ?? 2],
    ["warning_std_dev_hours", allocStats?.fairnessWarningStdDevHours ?? 4],
    ["fairness_repair_attempted", allocStats?.fairnessRepairAttempted ? "yes" : "no"],
    ["fairness_repair_moves", allocStats?.fairnessRepairMoveCount ?? ""],
    ["high_std_dev_reason", allocStats?.fairnessHighStdDevReason ?? ""],
  ]);

  const auditSheet = workbook.addWorksheet("Allocation Audit");
  auditSheet.addRow(["shift_id", "stable_shift_key", "date", "start_time", "end_time", "assigned", "availability_count", "reason"]);
  for (const rowItem of allocationAudit) {
    auditSheet.addRow([
      rowItem.shiftId,
      rowItem.stableShiftKey,
      rowItem.date,
      formatTime12(rowItem.startTime),
      formatTime12(rowItem.endTime),
      rowItem.assignedRespondentName ?? "",
      rowItem.availabilityCount,
      rowItem.reasonCategory,
    ]);
  }

  const afpSheet = workbook.addWorksheet("AFP Analysis");
  afpSheet.addRow(["name", "total_hours", "no_availability_placeholder_hours"]);
  for (const stat of allocStats?.afpStats ?? []) {
    afpSheet.addRow([stat.name, stat.totalHours, stat.noAvailabilityPlaceholderHours ?? 0]);
  }

  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow((worksheetRow) => {
      worksheetRow.eachCell((cell) => {
        cell.alignment = cell.alignment ?? { vertical: "middle", wrapText: true };
        cell.border = cell.border ?? border;
      });
    });
  }

  return workbook;
}
