#!/usr/bin/env node
// Read-only, loopback-only fixture server for documentation screenshots.
// No database, credentials, real respondents, or production API are used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "artifacts/shift-scheduler/dist/public");
const port = Number(process.env.DOCS_PORT || 4387);
const names = [
  "Alex Morgan",
  "Sam Rivera",
  "Jordan Lee",
  "Taylor Brooks",
  "Casey Patel",
  "Robin Chen",
  "Jamie Scott",
  "Avery Reed",
  "Morgan Ellis",
  "Drew Parker",
  "Quinn Davis",
  "Skyler Ross",
];
const stamp = "2026-09-19T16:00:00Z";
const shifts = [];
for (let day = 1; day <= 31; day++) {
  const date = `2026-10-${String(day).padStart(2, "0")}`;
  const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const slots = weekend
    ? [
        [8, 12],
        [12, 16],
        [16, 20],
      ]
    : [
        [9, 11],
        [11, 14],
        [14, 17],
        [17, 20],
      ];
  slots.forEach(([start, end], slotIndex) =>
    shifts.push({
      id: shifts.length + 1,
      surveyId: 1,
      date,
      dayType: weekend ? "weekend" : "weekday",
      startTime: `${String(start).padStart(2, "0")}:00`,
      endTime: `${end}:00`,
      durationHours: end - start,
      label: `${date} | ${start}:00–${end}:00`,
      slotIndex,
    }),
  );
}
const total = (rows) => rows.reduce((n, s) => n + s.durationHours, 0);
const respondents = names.map((name, index) => ({
  id: index + 1,
  name,
  preferredName: name.split(" ")[0],
  email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
  category: "General",
  createdAt: stamp,
}));
// Deterministic illustrative schedule; this fixture does not run the optimizer.
const assignedTo = (shift) => ((shift.id - 1) % names.length) + 1;
const availableTo = (shift, id) =>
  [
    assignedTo(shift),
    ((assignedTo(shift) + 3) % names.length) + 1,
    ((assignedTo(shift) + 7) % names.length) + 1,
  ].includes(id);
const responses = respondents.map((r) => {
  const selected = shifts.filter((s) => availableTo(s, r.id));
  return {
    ...r,
    respondentId: r.id,
    selectedShiftIds: selected.map((s) => s.id),
    totalAvailableHours: total(selected),
    hasPenalty: false,
    penaltyHours: 0,
    hasAfpCap: false,
    afpHoursCap: 10,
    includedInLatestAllocation: true,
  };
});
const allocations = respondents.map((r) => {
  const selected = shifts
    .filter((s) => assignedTo(s) === r.id)
    .map((s) => ({
      ...s,
      shiftId: s.id,
      stableShiftKey: `${s.date}|${s.startTime}|${s.endTime}`,
      assignmentSource: "engine_normal",
      isManual: false,
      isEmergency: false,
      explanationCodes: [],
    }));
  return {
    respondentId: r.id,
    name: r.name,
    category: r.category,
    allocatedShifts: selected,
    totalHours: total(selected),
    isManuallyAdjusted: false,
  };
});
const mean = total(shifts) / names.length;
const variance =
  allocations.reduce((n, r) => n + (r.totalHours - mean) ** 2, 0) /
  names.length;
const sorted = allocations.map((r) => r.totalHours).sort((a, b) => a - b);
const survey = {
  id: 1,
  title: "October 2026 · Demo",
  month: 10,
  year: 2026,
  status: "closed",
  token: "demo-october",
  closesAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  responseCount: names.length,
};
const respondentStats = allocations.map((r) => ({
  ...r,
  shiftCount: r.allocatedShifts.length,
  weekdayShifts: r.allocatedShifts.filter((s) => s.dayType === "weekday")
    .length,
  weekendShifts: r.allocatedShifts.filter((s) => s.dayType === "weekend")
    .length,
  weekdayHours: total(r.allocatedShifts.filter((s) => s.dayType === "weekday")),
  weekendHours: total(r.allocatedShifts.filter((s) => s.dayType === "weekend")),
  hasPenalty: false,
  penaltyHours: 0,
  penaltyGapHours: 0,
  targetHours: mean,
  neutralTargetHours: mean,
  effectivePenaltyHours: 0,
  unappliedPenaltyHours: 0,
  availableCapacityHours: responses[r.respondentId - 1].totalAvailableHours,
  deviationFromTargetHours: r.totalHours - mean,
  sameDayDoubleCount: 0,
  normalHours: r.totalHours,
  afpCapOverflowHours: 0,
  noAvailabilityPlaceholderHours: 0,
  manualHours: 0,
  fairnessStatus: "within_target",
}));
const allocationStats = {
  meanHours: mean,
  averageHours: mean,
  medianHours: (sorted[5] + sorted[6]) / 2,
  stdDev: Math.sqrt(variance),
  minHours: sorted[0],
  maxHours: sorted.at(-1),
  totalAllocatedHours: total(shifts),
  respondentStats,
  afpStats: [],
  generalStats: respondentStats,
  nonPenalizedGeneralStats: respondentStats,
  penalizedStats: [],
  nonPenalizedGeneralMeanHours: mean,
  nonPenalizedGeneralMedianHours: (sorted[5] + sorted[6]) / 2,
  nonPenalizedGeneralMinHours: sorted[0],
  nonPenalizedGeneralMaxHours: sorted.at(-1),
  nonPenalizedGeneralRangeHours: sorted.at(-1) - sorted[0],
  nonPenalizedGeneralStdDevHours: Math.sqrt(variance),
  fairnessTargetStdDevHours: 2,
  fairnessWarningStdDevHours: 4,
  fairnessWarning: false,
  fairnessRepairAttempted: false,
  fairnessHighStdDevReason: "",
};
for (const key of [
  "blankShiftCount",
  "blankWithAvailabilityCount",
  "noAvailabilityBlankCount",
  "manualAssignmentCount",
  "backToBackEmergencyCount",
  "noAvailabilityFallbackCount",
  "allowedNoAvailabilityAfpPlaceholderAssignments",
  "illegalAssignmentsWithoutAvailability",
  "noAvailabilityAfpPlaceholderCount",
  "noAvailabilityShiftsStillBlank",
  "afpNoAvailabilityPlaceholderHours",
  "afpCapOverflowCount",
  "normalAssignmentsWithoutAvailability",
  "manualAssignmentsWithoutAvailability",
  "fallbackAssignmentsWithoutAvailability",
  "assignmentsWithoutAvailabilityCount",
  "renderedBlankButAssignedCount",
  "availabilityMappingFailureCount",
  "nonAdjacentSameDayDoubleCount",
  "tripleShiftDayCount",
  "fairnessRepairMoveCount",
])
  allocationStats[key] = 0;
allocationStats.maxDeviationFromMeanHours = Math.max(
  ...allocations.map((r) => Math.abs(r.totalHours - mean)),
);
allocationStats.maxDeviationFromTargetHours =
  allocationStats.maxDeviationFromMeanHours;
allocationStats.sumSquaredDeviationFromTargetHours = variance * names.length;
const allocationAudit = shifts.map((s) => ({
  shiftId: s.id,
  stableShiftKey: `${s.date}|${s.startTime}|${s.endTime}`,
  date: s.date,
  dayOfWeek: new Date(`${s.date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  }),
  startTime: s.startTime,
  endTime: s.endTime,
  slotIndex: s.slotIndex,
  durationMinutes: s.durationHours * 60,
  renderedCellIsBlank: false,
  allocationRecordExists: true,
  assignedRespondentId: String(assignedTo(s)),
  assignedRespondentName: names[assignedTo(s) - 1],
  assignmentSource: "engine_normal",
  availabilityCount: 3,
  availableRespondents: respondents
    .filter((r) => availableTo(s, r.id))
    .map((r) => ({
      respondentId: r.id,
      name: r.name,
      category: r.category,
      penaltyHours: 0,
      afpCapHours: 0,
      alreadyAssignedMinutes: 0,
      sameDayAssignedShiftIds: [],
      canTakeNormally: true,
      canTakeBackToBackEmergency: false,
      blockers: [],
    })),
  eligibleNormalCandidateCount: 3,
  eligibleBackToBackEmergencyCandidateCount: 0,
  eligibleNoAvailabilityFallbackAfpCount: 0,
  reasonCategory: "ASSIGNED",
  explanationText: "Illustrative assignment from submitted demo availability.",
}));
const fixtures = new Map([
  ["/api/healthz", { status: "ok" }],
  [
    "/api/auth/session",
    {
      authenticated: true,
      admin: { name: "Demo Coordinator", email: "demo@example.com" },
    },
  ],
  ["/api/public-config", { publicAppUrl: `http://127.0.0.1:${port}` }],
  ["/api/surveys", [survey]],
  ["/api/surveys/1", { ...survey, shifts }],
  ["/api/respond/demo-october", { ...survey, status: "open", shifts }],
  ["/api/respondents", respondents],
  ["/api/surveys/1/responses", responses],
  ["/api/surveys/1/deleted-responses", []],
  [
    "/api/surveys/1/allocation-snapshots",
    [
      {
        id: 1,
        surveyId: 1,
        label: "Before manual adjustments · Demo",
        reason: "manual_adjustment",
        allocationCount: shifts.length,
        createdAt: stamp,
      },
    ],
  ],
  [
    "/api/surveys/1/allocations",
    {
      surveyId: 1,
      allocations,
      averageHours: mean,
      stdDev: Math.sqrt(variance),
      unallocatedShiftIds: [],
      blankShiftExplanations: [],
      allocationAudit,
    },
  ],
  ["/api/surveys/1/allocation-stats", allocationStats],
  [
    "/api/surveys/1/stats",
    {
      totalRespondents: names.length,
      averageAvailableHours: (total(shifts) * 3) / names.length,
      stdDevAvailableHours: 0,
      shiftTypeStats: [],
      respondentStats: responses.map((r) => ({
        ...r,
        shiftsSelected: r.selectedShiftIds.length,
        weekdayShifts: shifts.filter(
          (s) => s.dayType === "weekday" && r.selectedShiftIds.includes(s.id),
        ).length,
        weekendShifts: shifts.filter(
          (s) => s.dayType === "weekend" && r.selectedShiftIds.includes(s.id),
        ).length,
      })),
    },
  ],
]);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Documentation preview is read-only." }));
    return;
  }
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname.startsWith("/api/")) {
    res.writeHead(fixtures.has(pathname) ? 200 : 404, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(
        fixtures.get(pathname) ?? {
          error: "No demo fixture for this endpoint.",
        },
      ),
    );
    return;
  }
  try {
    const asset = pathname.startsWith("/assets/")
      ? path.resolve(dist, `.${decodeURIComponent(pathname)}`)
      : path.join(dist, "index.html");
    if (!asset.startsWith(dist + path.sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    let bytes = await readFile(asset);
    // Generic branding only in this documentation preview, never in production.
    if (path.extname(asset) === ".js") {
      bytes = Buffer.from(bytes.toString("utf8")
        .replaceAll("International Student House, Washington DC", "Shift Allocator")
        .replaceAll("I-House Front Desk", "Monthly Scheduling")
        .replaceAll("I-House", "organization")
        .replaceAll("ISH Front Desk Allocator", "Shift Allocator"));
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(asset)] || "application/octet-stream",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch {
    res.writeHead(404);
    res.end(
      "Build the frontend first: pnpm --filter @workspace/shift-scheduler build",
    );
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Read-only documentation demo: http://127.0.0.1:${port}/admin/surveys`,
  ),
);
