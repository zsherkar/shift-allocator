import { useState, useRef, useMemo, useEffect } from "react";
import { useParams } from "wouter";
import { AdminLayout } from "@/components/AdminLayout";
import { ExcelScheduleCalendar } from "@/components/ExcelScheduleCalendar";
import { RespondentHistoryPanel } from "@/components/RespondentHistoryPanel";
import {
  useGetSurvey,
  useUpdateSurvey,
  useGetSurveyResponses,
  useGetSurveyStats,
  useDeleteSurveyResponse,
  useDeletedSurveyResponses,
  useRestoreSurveyResponse,
  useUpdateSurveyResponse,
} from "@/hooks/use-surveys";
import {
  useGetAllocations,
  useGetAllocationSnapshots,
  useRunAllocation,
  useDryRunAllocation,
  useGetAllocationStats,
  useAdjustAllocation,
  useRestoreAllocationSnapshot,
} from "@/hooks/use-allocations";
import { useGetRespondentFdHistory, useUpdateRespondent } from "@/hooks/use-respondents";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ArrowLeft,
  Lock,
  LockOpen,
  Calendar,
  Users,
  BarChart3,
  Clock,
  Settings,
  BrainCircuit,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Image,
  History,
  Trash2,
  Undo2,
} from "lucide-react";
import { Link } from "wouter";
import { clsx } from "clsx";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import type { Borders, Fill, Style } from "exceljs";
import { format, parseISO } from "date-fns";
import { buildCalendarWorkbook } from "@/lib/calendarXlsx";
import { formatAllocationDisplayName } from "@/lib/allocationDisplay";
import type { AllocationDryRunRespondentPlan } from "@workspace/api-client-react";

function formatTime12(time: string) {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

function formatShiftDisplay(shift: { date: string; startTime: string; endTime: string }) {
  return `${format(parseISO(shift.date), "EEE, MMM d")} - ${formatTime12(shift.startTime)} - ${formatTime12(shift.endTime)}`;
}

function formatShiftLabelText(label: string) {
  if (/\b(?:AM|PM)\b/i.test(label)) return label;
  return label.replace(/\b(\d{1,2}:\d{2})\b/g, (match) => formatTime12(match));
}

function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function displayRespondentName(response: { name: string; preferredName: string }) {
  const preferredName = response.preferredName.trim();
  return preferredName && !isEmailLike(preferredName) ? preferredName : response.name;
}

function escapeCsvCell(value: string | number | null | undefined) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type AllocationStatSummary = {
  count: number;
  average: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  total: number;
  maxDeviation: number;
};

function summarizeAllocationStats(stats: Array<{ totalHours: number }>): AllocationStatSummary {
  const hours = stats.map((s) => s.totalHours).sort((a, b) => a - b);
  const total = hours.reduce((sum, value) => sum + value, 0);
  const count = hours.length;
  const average = count > 0 ? total / count : 0;
  const midpoint = Math.floor(count / 2);
  const median = count === 0 ? 0 : count % 2 === 0 ? (hours[midpoint - 1] + hours[midpoint]) / 2 : hours[midpoint];
  const variance = count > 0 ? hours.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / count : 0;
  const stdDev = Math.sqrt(variance);
  const maxDeviation = count > 0 ? Math.max(...hours.map((value) => Math.abs(value - average))) : 0;

  return {
    count,
    average,
    median,
    stdDev,
    min: count > 0 ? hours[0] : 0,
    max: count > 0 ? hours[hours.length - 1] : 0,
    total,
    maxDeviation,
  };
}

function AllocationSummaryPanel({
  title,
  note,
  summary,
}: {
  title: string;
  note: string;
  summary: AllocationStatSummary;
}) {
  const withinOneDeviation = summary.count <= 2 || summary.maxDeviation <= summary.stdDev + 0.01;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-slate-900">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">{note}</p>
        </div>
        <Badge
          variant="outline"
          className={clsx(
            "rounded-md",
            withinOneDeviation
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700",
          )}
        >
          {summary.count} people
        </Badge>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-slate-500">Mean</p>
          <p className="text-lg font-bold text-slate-900">{summary.average.toFixed(1)} hrs</p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-slate-500">Std Dev</p>
          <p className="text-lg font-bold text-slate-900">{summary.stdDev.toFixed(2)}</p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-slate-500">Range</p>
          <p className="text-lg font-bold text-slate-900">
            {summary.min}-{summary.max} hrs
          </p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-slate-500">Median</p>
          <p className="text-lg font-bold text-slate-900">{summary.median.toFixed(1)} hrs</p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-slate-500">Total</p>
          <p className="text-lg font-bold text-slate-900">{summary.total.toFixed(1)} hrs</p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-slate-500">Max Gap</p>
          <p className="text-lg font-bold text-slate-900">{summary.maxDeviation.toFixed(1)} hrs</p>
        </div>
      </div>
    </div>
  );
}

function DryRunRespondentPlanTable({ plans }: { plans: AllocationDryRunRespondentPlan[] }) {
  const sortedPlans = [...plans].sort(
    (a, b) =>
      Number(a.hasAfpCap) - Number(b.hasAfpCap) ||
      Number(a.hasPenalty) - Number(b.hasPenalty) ||
      a.name.localeCompare(b.name),
  );

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <p className="font-semibold text-slate-900">Proposed hours by person</p>
        <p className="text-xs text-slate-500">
          Review these totals before saving. Strike targets show the neutral share followed by the reduced target.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead className="bg-white text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Rule</th>
              <th className="px-4 py-3">Available</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Proposed</th>
              <th className="px-4 py-3">From target</th>
              <th className="px-4 py-3">Same-day doubles</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {sortedPlans.map((plan) => {
              const deviationIsLarge = Math.abs(plan.deviationFromTargetHours) >= 4;
              return (
                <tr key={plan.respondentId}>
                  <td className="px-4 py-3 font-semibold text-slate-900">{plan.name}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {plan.hasAfpCap
                      ? "AFP cap"
                      : plan.hasPenalty
                        ? `Strike -${plan.penaltyHours.toFixed(1)}h`
                        : "Equal pool"}
                    {plan.capacityLimited && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                        availability-limited
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{plan.availableCapacityHours.toFixed(1)}h</td>
                  <td className="px-4 py-3 text-slate-700">
                    {plan.hasPenalty
                      ? `${plan.neutralTargetHours.toFixed(1)}h → ${plan.targetHours.toFixed(1)}h`
                      : `${plan.targetHours.toFixed(1)}h`}
                  </td>
                  <td className="px-4 py-3 font-bold text-slate-900">{plan.totalHours.toFixed(1)}h</td>
                  <td
                    className={clsx(
                      "px-4 py-3 font-semibold",
                      deviationIsLarge ? "text-amber-700" : "text-emerald-700",
                    )}
                  >
                    {plan.deviationFromTargetHours >= 0 ? "+" : ""}
                    {plan.deviationFromTargetHours.toFixed(1)}h
                  </td>
                  <td className="px-4 py-3 text-slate-700">{plan.sameDayDoubleCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdminSurveyDetail() {
  const { id } = useParams<{ id: string }>();
  const surveyId = parseInt(id, 10);

  const { data: survey, isLoading: isSurveyLoading } = useGetSurvey(surveyId);
  const { data: responses, refetch: refetchResponses } = useGetSurveyResponses(surveyId);
  const { data: deletedResponses = [] } = useDeletedSurveyResponses(surveyId);
  const { data: stats, refetch: refetchStats } = useGetSurveyStats(surveyId);
  const { data: allocations, refetch: refetchAllocations } = useGetAllocations(surveyId);
  const { data: allocationSnapshots = [] } = useGetAllocationSnapshots(surveyId);
  const { data: allocStats, refetch: refetchAllocationStats } = useGetAllocationStats(surveyId);

  const updateMutation = useUpdateSurvey();
  const runAllocMutation = useRunAllocation();
  const dryRunAllocationMutation = useDryRunAllocation();
  const adjustAllocationMutation = useAdjustAllocation();
  const restoreAllocationSnapshotMutation = useRestoreAllocationSnapshot();
  const updateResponseMutation = useUpdateSurveyResponse();
  const restoreResponseMutation = useRestoreSurveyResponse();
  const updateRespondentMutation = useUpdateRespondent();

  const [afpIds, setAfpIds] = useState<Set<number>>(new Set());
  const [allowNoAvailabilityAfpPlaceholders, setAllowNoAvailabilityAfpPlaceholders] = useState(false);
  const [noAvailabilityFallbackAfpIds, setNoAvailabilityFallbackAfpIds] = useState<Set<number>>(new Set());
  const [allowAfpOverCapForAvailableShifts, setAllowAfpOverCapForAvailableShifts] = useState(false);
  const [preserveManualLocks, setPreserveManualLocks] = useState(true);
  const [showCalendar, setShowCalendar] = useState(false);
  const [selectedRespondentId, setSelectedRespondentId] = useState<number | null>(null);
  const [selectedResponse, setSelectedResponse] = useState<any | null>(null);
  const [selectedShiftIds, setSelectedShiftIds] = useState<Set<number>>(new Set());
  const [selectedName, setSelectedName] = useState("");
  const [selectedPreferredName, setSelectedPreferredName] = useState("");
  const [selectedEmail, setSelectedEmail] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<"AFP" | "General">("General");
  const [selectedHasPenalty, setSelectedHasPenalty] = useState(false);
  const [selectedPenaltyHours, setSelectedPenaltyHours] = useState(0);
  const [selectedHasAfpCap, setSelectedHasAfpCap] = useState(false);
  const [selectedAfpHoursCap, setSelectedAfpHoursCap] = useState(10);
  const [includedRespondentIds, setIncludedRespondentIds] = useState<Set<number>>(new Set());
  const [statsShift, setStatsShift] = useState<{
    id: number;
    label: string;
    names: string[];
  } | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<number | null>(null);
  const [adjustShiftIds, setAdjustShiftIds] = useState<Set<number>>(new Set());
  const [adjustNoAvailabilityPlaceholder, setAdjustNoAvailabilityPlaceholder] = useState(false);
  const deleteResponseMutation = useDeleteSurveyResponse();
  const calendarRef = useRef<HTMLDivElement>(null);
  const didInitializeIncludedIds = useRef(false);
  const { data: respondentHistory } = useGetRespondentFdHistory(selectedRespondentId ?? 0);
  const hasExistingAllocations = (allocations?.allocations.length ?? 0) > 0;
  const blankShiftExplanations = allocations?.blankShiftExplanations ?? [];
  const allocationAudit = allocations?.allocationAudit ?? [];
  const isPlaceholderSource = (source: string | null | undefined) =>
    source === "admin_no_availability_afp_placeholder" || source === "engine_no_availability_afp_fallback";
  const availabilityCountByShiftId = useMemo(() => {
    const map = new Map<number, number>();
    for (const response of (responses ?? []).filter((entry) => entry.includedInLatestAllocation)) {
      for (const shiftId of response.selectedShiftIds) {
        map.set(shiftId, (map.get(shiftId) ?? 0) + 1);
      }
    }
    return map;
  }, [responses]);
  const generalAllocationSummary = useMemo(
    () =>
      summarizeAllocationStats(
        allocStats?.nonPenalizedGeneralStats ??
          allocStats?.generalStats ??
          allocations?.allocations.filter((allocation) => allocation.category === "General") ??
          [],
      ),
    [allocStats?.generalStats, allocStats?.nonPenalizedGeneralStats, allocations?.allocations],
  );
  const penalizedAllocationSummary = useMemo(
    () => summarizeAllocationStats(allocStats?.penalizedStats ?? []),
    [allocStats?.penalizedStats],
  );
  const afpAllocationSummary = useMemo(
    () =>
      summarizeAllocationStats(
        allocStats?.afpStats ?? allocations?.allocations.filter((allocation) => allocation.category === "AFP") ?? [],
      ),
    [allocStats?.afpStats, allocations?.allocations],
  );

  useEffect(() => {
    if (!responses?.length) return;
    setIncludedRespondentIds((prev) => {
      const responseIds = new Set(responses.map((r) => r.respondentId));
      if (!didInitializeIncludedIds.current) {
        didInitializeIncludedIds.current = true;
        return new Set(
          responses.filter((response) => response.includedInLatestAllocation).map((response) => response.respondentId),
        );
      }
      return new Set(Array.from(prev).filter((id) => responseIds.has(id)));
    });
  }, [responses]);

  useEffect(() => {
    if (!responses) return;
    setAfpIds(new Set(responses.filter((r) => r.hasAfpCap).map((r) => r.respondentId)));
  }, [responses]);

  const toggleNoAvailabilityFallbackAfp = (id: number) => {
    const next = new Set(noAvailabilityFallbackAfpIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setNoAvailabilityFallbackAfpIds(next);
  };

  const toggleIncludedRespondent = (id: number) => {
    const next = new Set(includedRespondentIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setIncludedRespondentIds(next);
  };

  const toggleSelectedShift = (shiftId: number) => {
    const next = new Set(selectedShiftIds);
    if (next.has(shiftId)) next.delete(shiftId);
    else next.add(shiftId);
    setSelectedShiftIds(next);
  };

  const openResponseEditor = (response: NonNullable<typeof responses>[number]) => {
    setSelectedResponse(response);
    setSelectedShiftIds(new Set(response.selectedShiftIds));
    setSelectedName(response.name);
    setSelectedPreferredName(response.preferredName);
    setSelectedEmail(response.email || "");
    setSelectedCategory(response.category);
    setSelectedHasPenalty(Boolean(response.hasPenalty));
    setSelectedPenaltyHours(Number(response.penaltyHours ?? 0));
    setSelectedHasAfpCap(Boolean(response.hasAfpCap));
    setSelectedAfpHoursCap(Number(response.afpHoursCap ?? 10));
  };

  const saveSelectedRespondentDetails = async () => {
    if (!selectedResponse) return;
    const updatedRespondent = await updateRespondentMutation.mutateAsync({
      id: selectedResponse.respondentId,
      data: {
        name: selectedName,
        preferredName: selectedPreferredName || null,
        email: selectedEmail || null,
        category: selectedCategory,
      },
    });
    await Promise.all([refetchResponses(), refetchStats(), refetchAllocations(), refetchAllocationStats()]);
    setSelectedResponse({
      ...selectedResponse,
      name: updatedRespondent.name,
      preferredName: updatedRespondent.preferredName,
      email: updatedRespondent.email,
      category: updatedRespondent.category,
    });
    setSelectedName(updatedRespondent.name);
    setSelectedPreferredName(updatedRespondent.preferredName);
    setSelectedEmail(updatedRespondent.email || "");
    setSelectedCategory(updatedRespondent.category);
    if (updatedRespondent.category !== "AFP" && selectedHasAfpCap) {
      await updateResponseMutation.mutateAsync({
        surveyId,
        respondentId: selectedResponse.respondentId,
        selectedShiftIds: Array.from(selectedShiftIds),
        hasPenalty: selectedHasPenalty,
        penaltyHours: selectedHasPenalty ? selectedPenaltyHours : 0,
        hasAfpCap: false,
        afpHoursCap: selectedAfpHoursCap,
      });
      setSelectedHasAfpCap(false);
    }
  };

  const updateResponseSettings = async (
    response: NonNullable<typeof responses>[number],
    updates: {
      hasPenalty?: boolean;
      penaltyHours?: number;
      hasAfpCap?: boolean;
      afpHoursCap?: number;
    },
  ) => {
    const nextHasPenalty = updates.hasPenalty ?? Boolean(response.hasPenalty);
    const nextPenaltyHours = updates.penaltyHours ?? Number(response.penaltyHours ?? 0);
    const nextHasAfpCap = updates.hasAfpCap ?? Boolean(response.hasAfpCap);
    const nextAfpHoursCap = updates.afpHoursCap ?? Number(response.afpHoursCap ?? 10);
    await updateResponseMutation.mutateAsync({
      surveyId,
      respondentId: response.respondentId,
      selectedShiftIds: response.selectedShiftIds,
      hasPenalty: nextHasPenalty,
      penaltyHours: nextHasPenalty ? nextPenaltyHours : 0,
      hasAfpCap: nextHasAfpCap,
      afpHoursCap: nextAfpHoursCap,
    });
  };

  const toggleAfp = async (response: NonNullable<typeof responses>[number]) => {
    const id = response.respondentId;
    const enabled = !afpIds.has(id);
    setAfpIds((current) => {
      const next = new Set(current);
      if (enabled) next.add(id);
      else next.delete(id);
      return next;
    });

    try {
      await updateResponseSettings(response, {
        hasAfpCap: enabled,
        afpHoursCap: Number(response.afpHoursCap ?? 10),
      });
    } catch (error) {
      setAfpIds((current) => {
        const next = new Set(current);
        if (enabled) next.delete(id);
        else next.add(id);
        return next;
      });
      alert(error instanceof Error ? error.message : "Failed to update AFP cap");
    }
  };

  const handleCloseSurvey = () => {
    if (confirm("Close this survey? Respondents will no longer be able to submit availability.")) {
      updateMutation.mutate({ id: surveyId, data: { status: "closed" } });
    }
  };

  const handleReopenSurvey = () => {
    if (confirm("Reopen this survey? Respondents will be able to submit availability again.")) {
      updateMutation.mutate({
        id: surveyId,
        data: { status: "open", closesAt: null },
      });
    }
  };

  const handleRunAllocation = () => {
    if (survey?.status !== "closed") {
      alert("Survey must be closed before running allocation.");
      return;
    }
    if (includedRespondentIds.size === 0) {
      alert("Select at least one respondent to include in allocation.");
      return;
    }
    if (
      hasExistingAllocations &&
      !confirm("Run a new allocation? The current schedule will be saved as a recovery point first.")
    ) {
      return;
    }
    runAllocMutation.mutate(
      {
        id: surveyId,
        data: {
          afpRespondentIds: Array.from(afpIds),
          allowNoAvailabilityAfpPlaceholders,
          noAvailabilityFallbackAfpIds: allowNoAvailabilityAfpPlaceholders
            ? Array.from(noAvailabilityFallbackAfpIds)
            : [],
          afpUnclaimedShiftRespondentIds: allowNoAvailabilityAfpPlaceholders
            ? Array.from(noAvailabilityFallbackAfpIds)
            : [],
          includedRespondentIds: Array.from(includedRespondentIds),
          allowAfpOverCapForAvailableShifts,
          preserveManualLocks,
        },
      },
      { onSuccess: () => setShowCalendar(true) },
    );
  };

  const handleRestoreAllocationSnapshot = async (snapshot: NonNullable<typeof allocationSnapshots>[number]) => {
    const createdAt = format(new Date(snapshot.createdAt), "MMM d, yyyy h:mm a");
    if (
      !confirm(`Restore the ${createdAt} allocation? The current schedule will be saved as a new recovery point first.`)
    ) {
      return;
    }
    try {
      await restoreAllocationSnapshotMutation.mutateAsync({
        id: surveyId,
        snapshotId: snapshot.id,
      });
      setShowCalendar(true);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to restore allocation");
    }
  };

  const handleDryRunAllocation = () => {
    if (survey?.status !== "closed") {
      alert("Survey must be closed before dry-running allocation.");
      return;
    }
    if (includedRespondentIds.size === 0) {
      alert("Select at least one respondent to include in allocation.");
      return;
    }
    dryRunAllocationMutation.mutate({
      id: surveyId,
      data: {
        afpRespondentIds: Array.from(afpIds),
        allowNoAvailabilityAfpPlaceholders,
        noAvailabilityFallbackAfpIds: allowNoAvailabilityAfpPlaceholders
          ? Array.from(noAvailabilityFallbackAfpIds)
          : [],
        afpUnclaimedShiftRespondentIds: allowNoAvailabilityAfpPlaceholders
          ? Array.from(noAvailabilityFallbackAfpIds)
          : [],
        includedRespondentIds: Array.from(includedRespondentIds),
        allowAfpOverCapForAvailableShifts,
        preserveManualLocks,
      },
    });
  };

  const shiftStatsByShift = useMemo(() => {
    if (!survey?.shifts) return [];
    const responseList = (responses ?? []).filter((response) => response.includedInLatestAllocation);
    const respondentById = new Map(responseList.map((r) => [r.respondentId, r]));
    return survey.shifts.map((shift) => {
      const selectedBy = responseList
        .filter((r) => r.selectedShiftIds.includes(shift.id))
        .map((r) => r.preferredName || r.name);
      return {
        id: shift.id,
        label: formatShiftDisplay(shift),
        dayType: shift.dayType,
        totalSelections: selectedBy.length,
        selectionRate: respondentById.size > 0 ? selectedBy.length / respondentById.size : 0,
        selectedBy,
      };
    });
  }, [responses, survey?.shifts]);
  const editedSelectedHours = useMemo(
    () =>
      (survey?.shifts || [])
        .filter((shift) => selectedShiftIds.has(shift.id))
        .reduce((sum, shift) => sum + shift.durationHours, 0),
    [selectedShiftIds, survey?.shifts],
  );

  const renderCalendarCanvas = async () => {
    if (!calendarRef.current) return null;
    return html2canvas(calendarRef.current, {
      backgroundColor: "#ffffff",
      scale: 3,
      useCORS: true,
    });
  };

  const downloadPNG = async () => {
    const canvas = await renderCalendarCanvas();
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `${survey?.title ?? "schedule"}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const downloadPDF = async () => {
    const canvas = await renderCalendarCanvas();
    if (!canvas) return;
    const pdf = new jsPDF({
      orientation: "landscape",
      unit: "pt",
      format: "a4",
    });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 20;
    const printableWidth = pageWidth - margin * 2;
    const printableHeight = pageHeight - margin * 2;
    const pageScale = printableWidth / canvas.width;
    const sliceHeight = Math.max(1, Math.floor(printableHeight / pageScale));

    let offsetY = 0;
    let pageIndex = 0;

    while (offsetY < canvas.height) {
      const currentSliceHeight = Math.min(sliceHeight, canvas.height - offsetY);
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = canvas.width;
      pageCanvas.height = currentSliceHeight;

      const context = pageCanvas.getContext("2d");
      if (!context) return;

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      context.drawImage(
        canvas,
        0,
        offsetY,
        canvas.width,
        currentSliceHeight,
        0,
        0,
        pageCanvas.width,
        pageCanvas.height,
      );

      if (pageIndex > 0) {
        pdf.addPage("a4", "landscape");
      }

      pdf.addImage(
        pageCanvas.toDataURL("image/png"),
        "PNG",
        margin,
        margin,
        printableWidth,
        currentSliceHeight * pageScale,
        undefined,
        "FAST",
      );

      offsetY += currentSliceHeight;
      pageIndex += 1;
    }

    pdf.save(`${survey?.title ?? "schedule"}.pdf`);
  };

  const downloadScheduleCsv = () => {
    if (!survey?.shifts || !allocations?.allocations) return;

    const respondentById = new Map((responses ?? []).map((response) => [response.respondentId, response]));
    const blankByShiftId = new Map(blankShiftExplanations.map((blank) => [blank.shiftId, blank]));
    const allocationByShiftId = new Map<
      number,
      {
        name: string;
        email: string;
        category: string;
        totalHours: number;
        stableShiftKey: string;
        assignmentSource: string;
        isManual: boolean;
        isEmergency: boolean;
        explanationCodes: string[];
      }
    >();
    for (const allocation of allocations.allocations) {
      const respondent = respondentById.get(allocation.respondentId);
      for (const shift of allocation.allocatedShifts) {
        allocationByShiftId.set(shift.shiftId, {
          name: formatAllocationDisplayName(allocation.name, shift.assignmentSource),
          email: respondent?.email ?? "",
          category: allocation.category,
          totalHours: allocation.totalHours,
          stableShiftKey: shift.stableShiftKey,
          assignmentSource: shift.assignmentSource,
          isManual: shift.isManual,
          isEmergency: shift.isEmergency,
          explanationCodes: shift.explanationCodes,
        });
      }
    }

    const rows = [
      [
        "date",
        "stable_shift_key",
        "day_of_week",
        "shift_label",
        "start_time",
        "end_time",
        "duration_hours",
        "assigned_name",
        "assigned_email",
        "assigned_category",
        "assignment_source",
        "is_manual",
        "is_emergency",
        "is_blank",
        "blank_reason",
        "notes",
      ],
      ...[...survey.shifts]
        .sort((a, b) => `${a.date}-${a.startTime}`.localeCompare(`${b.date}-${b.startTime}`))
        .map((shift) => {
          const allocation = allocationByShiftId.get(shift.id);
          const blank = blankByShiftId.get(shift.id);
          return [
            shift.date,
            allocation?.stableShiftKey ?? blank?.stableShiftKey ?? "",
            format(parseISO(shift.date), "EEEE"),
            formatShiftLabelText(shift.label),
            formatTime12(shift.startTime),
            formatTime12(shift.endTime),
            shift.durationHours,
            allocation?.name ?? "",
            allocation?.email ?? "",
            allocation?.category ?? "",
            allocation?.assignmentSource ?? "blank",
            allocation?.isManual ? "yes" : "no",
            allocation?.isEmergency ? "yes" : "no",
            allocation ? "no" : "yes",
            allocation ? "" : (blank?.reasonCategory ?? "UNKNOWN"),
            allocation?.explanationCodes.join("; ") ?? blank?.explanationText ?? "",
          ];
        }),
    ];

    const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.download = `${survey?.title ?? "schedule"}.csv`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const downloadCalendarXlsx = async () => {
    if (!survey?.shifts || !allocations?.allocations) return;

    const workbook = await buildCalendarWorkbook({
      survey,
      allocations: allocations.allocations,
      responses,
      blankShiftExplanations,
      allocationAudit,
      allocStats,
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const link = document.createElement("a");
    link.download = `${survey?.title ?? "schedule"}-calendar.xlsx`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const downloadAuditCsv = () => {
    if (!allocationAudit.length) return;
    const rows = [
      [
        "shift_id",
        "stable_shift_key",
        "date",
        "day_of_week",
        "start_time",
        "end_time",
        "slot_index",
        "duration_minutes",
        "rendered_cell_is_blank",
        "allocation_record_exists",
        "assigned_respondent_id",
        "assigned_respondent_name",
        "assignment_source",
        "availability_count",
        "eligible_normal_candidate_count",
        "eligible_back_to_back_emergency_candidate_count",
        "fallback_without_availability_candidate_count",
        "reason_category",
        "available_respondents_and_blockers",
        "explanation",
      ],
      ...allocationAudit.map((row) => [
        row.shiftId,
        row.stableShiftKey,
        row.date,
        row.dayOfWeek,
        formatTime12(row.startTime),
        formatTime12(row.endTime),
        row.slotIndex,
        row.durationMinutes,
        row.renderedCellIsBlank ? "yes" : "no",
        row.allocationRecordExists ? "yes" : "no",
        row.assignedRespondentId ?? "",
        row.assignedRespondentName ?? "",
        row.assignmentSource ?? "",
        row.availabilityCount,
        row.eligibleNormalCandidateCount,
        row.eligibleBackToBackEmergencyCandidateCount,
        row.eligibleNoAvailabilityFallbackAfpCount,
        row.reasonCategory,
        row.availableRespondents
          .map(
            (respondent) =>
              `${respondent.name}: ${respondent.blockers.length ? respondent.blockers.join("|") : "eligible"}`,
          )
          .join("; "),
        row.explanationText,
      ]),
    ];
    const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.download = `${survey?.title ?? "schedule"}-allocation-audit.csv`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (isSurveyLoading || !survey)
    return (
      <AdminLayout>
        <div className="flex h-64 items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </AdminLayout>
    );

  return (
    <AdminLayout>
      <div className="mb-6">
        <Link
          href="/admin/surveys"
          className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors mb-4"
        >
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Surveys
        </Link>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-display font-bold text-slate-900">{survey.title}</h1>
              <Badge variant={survey.status === "open" ? "default" : "secondary"} className="rounded-md">
                {survey.status}
              </Badge>
            </div>
            <div className="flex items-center gap-4 mt-2 text-sm text-slate-500 font-medium">
              <span className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4" /> {survey.shifts?.length || 0} Shifts
              </span>
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4" /> {survey.responseCount || 0} Responses
              </span>
            </div>
          </div>
          <div className="flex gap-3">
            {survey.status === "open" && (
              <Button
                variant="outline"
                onClick={handleCloseSurvey}
                disabled={updateMutation.isPending}
                className="rounded-xl border-amber-200 text-amber-700 hover:bg-amber-50"
              >
                <Lock className="w-4 h-4 mr-2" /> Close Survey
              </Button>
            )}
            {survey.status === "closed" && (
              <Button
                variant="outline"
                onClick={handleReopenSurvey}
                disabled={updateMutation.isPending}
                className="rounded-xl border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              >
                <LockOpen className="w-4 h-4 mr-2" /> Reopen Survey
              </Button>
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="responses" className="w-full">
        <TabsList className="bg-slate-100/50 p-1 rounded-xl mb-6 inline-flex w-full overflow-x-auto justify-start">
          <TabsTrigger
            value="responses"
            className="rounded-lg px-4 py-2 data-[state=active]:bg-white data-[state=active]:shadow-sm"
          >
            Responses
          </TabsTrigger>
          <TabsTrigger
            value="deleted"
            className="rounded-lg px-4 py-2 data-[state=active]:bg-white data-[state=active]:shadow-sm"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Deleted ({deletedResponses.length})
          </TabsTrigger>
          <TabsTrigger
            value="stats"
            className="rounded-lg px-4 py-2 data-[state=active]:bg-white data-[state=active]:shadow-sm"
          >
            Availability Stats
          </TabsTrigger>
          <TabsTrigger
            value="allocation"
            className="rounded-lg px-4 py-2 data-[state=active]:bg-white data-[state=active]:shadow-sm"
          >
            Allocation
          </TabsTrigger>
          {hasExistingAllocations && allocStats && (
            <>
              <TabsTrigger
                value="alloc-stats"
                className="rounded-lg px-4 py-2 data-[state=active]:bg-white data-[state=active]:shadow-sm"
              >
                Post-Alloc Stats
              </TabsTrigger>
              <TabsTrigger
                value="alloc-audit"
                className="rounded-lg px-4 py-2 data-[state=active]:bg-white data-[state=active]:shadow-sm"
              >
                Allocation Audit
              </TabsTrigger>
            </>
          )}
        </TabsList>

        {/* Responses Tab */}
        <TabsContent value="responses" className="animate-in fade-in duration-300">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/80 text-sm text-slate-600">
              Keep a respondent checked under <strong>Use</strong> to include their saved availability in allocation.
              Clicking a respondent lets you add or remove shifts from that saved availability before you run the
              schedule.
            </div>
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4">Use</th>
                  <th className="px-6 py-4">Respondent</th>
                  <th className="px-6 py-4">Target reduction</th>
                  <th className="px-6 py-4">AFP Cap</th>
                  <th className="px-6 py-4">Shifts Selected</th>
                  <th className="px-6 py-4">Total Available Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {!responses?.length ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                      No responses yet.
                    </td>
                  </tr>
                ) : (
                  responses.map((r) => (
                    <tr key={r.respondentId} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <Checkbox
                          checked={includedRespondentIds.has(r.respondentId)}
                          onCheckedChange={() => toggleIncludedRespondent(r.respondentId)}
                        />
                      </td>
                      <td className="px-6 py-4 font-medium text-slate-900">
                        <button
                          className="underline decoration-dotted underline-offset-4 hover:text-indigo-700"
                          onClick={() => {
                            openResponseEditor(r);
                          }}
                        >
                          {displayRespondentName(r)}
                        </button>
                        <div className="mt-1 text-xs font-normal text-slate-500">
                          {r.name}
                          {r.email ? ` | ${r.email}` : ""}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={Boolean(r.hasPenalty)}
                            onCheckedChange={(checked) => {
                              void updateResponseSettings(r, {
                                hasPenalty: checked === true,
                                penaltyHours: checked === true ? Math.max(1, Number(r.penaltyHours ?? 0)) : 0,
                              });
                            }}
                          />
                          <Input
                            type="number"
                            min={0}
                            step={0.5}
                            defaultValue={r.penaltyHours ?? 0}
                            disabled={!r.hasPenalty || updateResponseMutation.isPending}
                            className="h-8 w-20 rounded-md"
                            onBlur={(event) => {
                              const value = Math.max(0, Number(event.currentTarget.value || 0));
                              if (value !== Number(r.penaltyHours ?? 0)) {
                                void updateResponseSettings(r, {
                                  hasPenalty: value > 0,
                                  penaltyHours: value,
                                });
                              }
                            }}
                          />
                          <span className="text-xs text-slate-500">hrs</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {r.category === "AFP" ? (
                          <div className="flex items-center gap-2">
                            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                              <Checkbox
                                checked={afpIds.has(r.respondentId)}
                                disabled={updateResponseMutation.isPending}
                                onCheckedChange={() => void toggleAfp(r)}
                              />
                              Add
                            </label>
                            {afpIds.has(r.respondentId) && (
                              <>
                                <Input
                                  type="number"
                                  min={0}
                                  step={0.5}
                                  defaultValue={r.afpHoursCap ?? 10}
                                  disabled={updateResponseMutation.isPending}
                                  className="h-8 w-20 rounded-md"
                                  onBlur={(event) => {
                                    const value = Math.max(0, Number(event.currentTarget.value || 10));
                                    if (value !== Number(r.afpHoursCap ?? 10)) {
                                      void updateResponseSettings(r, {
                                        afpHoursCap: value,
                                      });
                                    }
                                  }}
                                />
                                <span className="text-xs text-slate-500">hrs</span>
                              </>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-slate-600">{r.selectedShiftIds.length} shifts</td>
                      <td className="px-6 py-4 font-semibold text-slate-700">{r.totalAvailableHours} hrs</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="deleted" className="animate-in fade-in duration-300">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-6 py-4 font-medium">Respondent</th>
                  <th className="px-6 py-4 font-medium">Deleted</th>
                  <th className="px-6 py-4 font-medium">Shifts</th>
                  <th className="px-6 py-4 font-medium">Allocations</th>
                  <th className="px-6 py-4 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {deletedResponses.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-slate-500">
                      No deleted responses.
                    </td>
                  </tr>
                ) : (
                  deletedResponses.map((response) => (
                    <tr key={response.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-900">{displayRespondentName(response)}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {response.name}
                          {response.email ? ` | ${response.email}` : ""}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-slate-600">
                        {format(parseISO(response.deletedAt), "MMM d, yyyy h:mm a")}
                      </td>
                      <td className="px-6 py-4 text-slate-600">{response.selectedShiftIds.length}</td>
                      <td className="px-6 py-4 text-slate-600">{response.allocationCount}</td>
                      <td className="px-6 py-4 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={restoreResponseMutation.isPending}
                          onClick={async () => {
                            if (!confirm(`Restore ${displayRespondentName(response)}'s response?`)) {
                              return;
                            }
                            try {
                              const result = await restoreResponseMutation.mutateAsync({
                                surveyId,
                                deletedResponseId: response.id,
                              });
                              if (result.skippedAllocationCount > 0) {
                                alert(
                                  `Response restored. ${result.skippedAllocationCount} allocation(s) were already assigned to someone else and were not overwritten.`,
                                );
                              }
                            } catch (error) {
                              alert(error instanceof Error ? error.message : "Failed to restore response");
                            }
                          }}
                        >
                          <Undo2 className="mr-2 h-4 w-4" />
                          Restore
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* Stats Tab */}
        <TabsContent value="stats" className="animate-in fade-in duration-300">
          {stats ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center justify-center text-center">
                <div className="w-12 h-12 bg-blue-50 text-blue-500 rounded-full flex items-center justify-center mb-3">
                  <Clock className="w-6 h-6" />
                </div>
                <h3 className="text-3xl font-display font-bold text-slate-900">
                  {stats.averageAvailableHours.toFixed(1)}
                </h3>
                <p className="text-sm font-medium text-slate-500">Avg Available Hours</p>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center justify-center text-center">
                <div className="w-12 h-12 bg-indigo-50 text-indigo-500 rounded-full flex items-center justify-center mb-3">
                  <BarChart3 className="w-6 h-6" />
                </div>
                <h3 className="text-3xl font-display font-bold text-slate-900">
                  +/-{stats.stdDevAvailableHours.toFixed(1)}
                </h3>
                <p className="text-sm font-medium text-slate-500">Standard Deviation</p>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center justify-center text-center">
                <div className="w-12 h-12 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center mb-3">
                  <Users className="w-6 h-6" />
                </div>
                <h3 className="text-3xl font-display font-bold text-slate-900">{stats.totalRespondents}</h3>
                <p className="text-sm font-medium text-slate-500">Total Respondents</p>
              </div>
              <div className="md:col-span-3 bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mt-2">
                <div className="p-4 border-b border-slate-100 bg-slate-50/50">
                  <h3 className="font-bold text-slate-900">Shift Popularity</h3>
                </div>
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 text-slate-500 font-medium">
                    <tr>
                      <th className="px-6 py-3">Shift</th>
                      <th className="px-6 py-3">Type</th>
                      <th className="px-6 py-3">Selections</th>
                      <th className="px-6 py-3">Selection Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shiftStatsByShift.map((s) => (
                      <tr key={s.id}>
                        <td className="px-6 py-3 font-medium text-slate-900">
                          <button
                            className="underline decoration-dotted underline-offset-4 hover:text-indigo-700"
                            onClick={() =>
                              setStatsShift({
                                id: s.id,
                                label: s.label,
                                names: s.selectedBy,
                              })
                            }
                          >
                            {s.label}
                          </button>
                        </td>
                        <td className="px-6 py-3 capitalize">{s.dayType}</td>
                        <td className="px-6 py-3">{s.totalSelections}</td>
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-24 h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full bg-primary" style={{ width: `${s.selectionRate * 100}%` }} />
                            </div>
                            <span className="text-xs font-medium text-slate-500">
                              {(s.selectionRate * 100).toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-12 text-center text-slate-500">Stats not available.</div>
          )}
        </TabsContent>

        {/* Allocation Tab */}
        <TabsContent value="allocation" className="animate-in fade-in duration-300 space-y-6">
          {survey.status !== "closed" && !hasExistingAllocations && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm font-medium">
              Close the survey first to run allocation.
            </div>
          )}

          {survey.status === "closed" && !hasExistingAllocations && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <h3 className="font-bold text-slate-900 mb-1 text-lg">AFP Hour Caps</h3>
              <p className="text-sm text-slate-500 mb-4">
                Enable a cap only for AFPs who should be limited this month. Unchecked AFPs join the equal-allocation
                pool.
              </p>
              {(responses ?? []).filter((response) => response.category === "AFP").length === 0 ? (
                <p className="text-slate-400 italic text-sm">No AFP responses yet.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-6">
                  {(responses ?? [])
                    .filter((response) => response.category === "AFP")
                    .map((r) => (
                      <label
                        key={r.respondentId}
                        className={clsx(
                          "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all",
                          afpIds.has(r.respondentId)
                            ? "border-indigo-400 bg-indigo-50"
                            : "border-slate-200 hover:border-indigo-200 hover:bg-slate-50",
                        )}
                      >
                        <Checkbox
                          checked={afpIds.has(r.respondentId)}
                          disabled={updateResponseMutation.isPending}
                          onCheckedChange={() => void toggleAfp(r)}
                          className="rounded data-[state=checked]:bg-indigo-600 data-[state=checked]:border-indigo-600"
                        />
                        <div>
                          <p className="font-medium text-slate-900 text-sm leading-tight">
                            {r.preferredName || r.name}
                          </p>
                          <p className="text-xs text-slate-400">{r.totalAvailableHours} hrs avail.</p>
                          {afpIds.has(r.respondentId) && (
                            <>
                              <div className="mt-2 flex items-center gap-2">
                                <span className="text-xs text-slate-500">Cap</span>
                                <Input
                                  type="number"
                                  min={0}
                                  step={0.5}
                                  defaultValue={r.afpHoursCap ?? 10}
                                  className="h-7 w-20 rounded-md bg-white"
                                  onClick={(event) => event.stopPropagation()}
                                  onBlur={(event) => {
                                    const value = Math.max(0, Number(event.currentTarget.value || 10));
                                    if (value !== Number(r.afpHoursCap ?? 10)) {
                                      void updateResponseSettings(r, {
                                        afpHoursCap: value,
                                      });
                                    }
                                  }}
                                />
                                <span className="text-xs text-slate-500">hrs</span>
                              </div>
                            </>
                          )}
                        </div>
                      </label>
                    ))}
                </div>
              )}
              <div className="mb-6 grid gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-700 sm:grid-cols-2">
                <label className="flex items-start gap-2">
                  <Checkbox
                    checked={preserveManualLocks}
                    onCheckedChange={(checked) => setPreserveManualLocks(Boolean(checked))}
                  />
                  <span>
                    Preserve manual assignments on re-run
                    <span className="block text-xs text-slate-500">
                      Manual rows stay locked and the engine allocates around them.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <Checkbox
                    checked={allowAfpOverCapForAvailableShifts}
                    onCheckedChange={(checked) => setAllowAfpOverCapForAvailableShifts(Boolean(checked))}
                  />
                  <span>
                    Allow AFP cap overflow for available shifts
                    <span className="block text-xs text-slate-500">Use only after normal legal candidates fail.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 sm:col-span-2">
                  <Checkbox
                    checked={allowNoAvailabilityAfpPlaceholders}
                    onCheckedChange={(checked) => setAllowNoAvailabilityAfpPlaceholders(Boolean(checked))}
                  />
                  <span>
                    Enable no-availability AFP emergency placeholders
                    <span className="block text-xs text-slate-500">
                      Only shifts nobody selected can be assigned to selected AFPs for visibility. These are not normal
                      availability-based assignments.
                    </span>
                  </span>
                </label>
                {allowNoAvailabilityAfpPlaceholders && (
                  <div className="sm:col-span-2 rounded-lg border border-indigo-100 bg-white p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-indigo-700">
                      AFPs eligible for zero-availability placeholders
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {(responses ?? [])
                        .filter((response) => response.category === "AFP")
                        .map((response) => (
                          <label
                            key={response.respondentId}
                            className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2"
                          >
                            <Checkbox
                              checked={noAvailabilityFallbackAfpIds.has(response.respondentId)}
                              onCheckedChange={() => toggleNoAvailabilityFallbackAfp(response.respondentId)}
                            />
                            <span className="text-sm font-medium text-slate-800">
                              {displayRespondentName(response)}
                            </span>
                          </label>
                        ))}
                    </div>
                    {(responses ?? []).every((response) => response.category !== "AFP") && (
                      <p className="text-xs text-slate-500">
                        No AFP responses are available for placeholder assignment.
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-4">
                <Button
                  onClick={handleRunAllocation}
                  disabled={runAllocMutation.isPending}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-8 h-12 text-base font-medium shadow-lg shadow-indigo-600/20"
                >
                  <BrainCircuit className="w-5 h-5 mr-2" />
                  {runAllocMutation.isPending ? "Allocating..." : "Run Allocation"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleDryRunAllocation}
                  disabled={dryRunAllocationMutation.isPending}
                  className="rounded-xl h-12"
                >
                  {dryRunAllocationMutation.isPending ? "Auditing..." : "Run Dry-Run Audit"}
                </Button>
                {afpIds.size > 0 && (
                  <span className="text-sm text-indigo-700 font-medium">
                    {afpIds.size} AFP cap{afpIds.size !== 1 ? "s" : ""} enabled
                  </span>
                )}
              </div>
              {dryRunAllocationMutation.data && (
                <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="font-bold text-slate-900">Dry-Run Audit</h4>
                      <p className="text-slate-500">
                        No responses, respondents, settings, or saved allocations were changed.
                      </p>
                    </div>
                    <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-indigo-700">
                      {dryRunAllocationMutation.data.assignedShifts}/{dryRunAllocationMutation.data.totalShifts}{" "}
                      assigned
                    </Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div>
                      <p className="text-xs text-slate-500">Blank with availability</p>
                      <p className="font-bold">{dryRunAllocationMutation.data.blankWithAvailabilityCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Blank zero availability</p>
                      <p className="font-bold">{dryRunAllocationMutation.data.blankZeroAvailabilityShiftCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">AFP placeholders</p>
                      <p className="font-bold">
                        {dryRunAllocationMutation.data.allowedNoAvailabilityAfpPlaceholderAssignments}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Illegal unavailable</p>
                      <p className="font-bold">{dryRunAllocationMutation.data.illegalAssignmentsWithoutAvailability}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Comparable-pool mean</p>
                      <p className="font-bold">
                        {dryRunAllocationMutation.data.nonPenalizedGeneralMeanHours.toFixed(1)} hrs
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Comparable-pool std dev</p>
                      <p className="font-bold">
                        {dryRunAllocationMutation.data.nonPenalizedGeneralStdDevHours.toFixed(2)} hrs
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Optimizer</p>
                      <p className="font-bold">
                        {dryRunAllocationMutation.data.optimizationMethod === "global_milp"
                          ? dryRunAllocationMutation.data.optimizerStatus === "optimal"
                            ? "Global exact"
                            : "Global bounded"
                          : "Fallback"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">B2B pair-days</p>
                      <p className="font-bold">{dryRunAllocationMutation.data.backToBackPairDays}</p>
                    </div>
                  </div>
                  <DryRunRespondentPlanTable plans={dryRunAllocationMutation.data.respondentPlans} />
                </div>
              )}
            </div>
          )}

          {hasExistingAllocations && allocations && (
            <div className="space-y-6">
              <div className="flex flex-wrap justify-between items-center bg-indigo-50 p-4 rounded-xl border border-indigo-100 gap-3">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-6 h-6 text-indigo-600 shrink-0" />
                  <div>
                    <h3 className="font-bold text-indigo-900">Allocation Complete</h3>
                    <p className="text-sm text-indigo-700">
                      Equal-allocation avg: {generalAllocationSummary.average.toFixed(1)} hrs | Std Dev:{" "}
                      {generalAllocationSummary.stdDev.toFixed(2)} | AFP caps enabled: {afpIds.size}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {survey.status === "closed" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleDryRunAllocation}
                        className="bg-white rounded-xl"
                        disabled={dryRunAllocationMutation.isPending}
                      >
                        {dryRunAllocationMutation.isPending ? "Auditing..." : "Dry-Run Audit"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRunAllocation}
                        className="bg-white rounded-xl"
                        disabled={runAllocMutation.isPending}
                      >
                        {runAllocMutation.isPending ? "Allocating..." : "Run Allocation"}
                      </Button>
                    </>
                  )}
                  {allocationAudit.length > 0 && (
                    <Button size="sm" variant="outline" onClick={downloadAuditCsv} className="bg-white rounded-xl">
                      <FileSpreadsheet className="w-4 h-4 mr-1" /> Download Audit
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowCalendar((v) => !v)}
                    className="bg-white rounded-xl"
                  >
                    <Calendar className="w-4 h-4 mr-1" />
                    {showCalendar ? "Hide Calendar" : "Show Calendar"}
                  </Button>
                  {showCalendar && (
                    <>
                      <Button size="sm" variant="outline" onClick={downloadPNG} className="bg-white rounded-xl">
                        <Image className="w-4 h-4 mr-1" /> Download PNG
                      </Button>
                      <Button size="sm" variant="outline" onClick={downloadPDF} className="bg-white rounded-xl">
                        <Download className="w-4 h-4 mr-1" /> Download PDF
                      </Button>
                      <Button size="sm" variant="outline" onClick={downloadScheduleCsv} className="bg-white rounded-xl">
                        <FileSpreadsheet className="w-4 h-4 mr-1" /> Download CSV
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={downloadCalendarXlsx}
                        className="bg-white rounded-xl"
                      >
                        <FileSpreadsheet className="w-4 h-4 mr-1" /> Download XLSX
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
                <h3 className="font-bold text-slate-900">Re-run Settings</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <label className="flex items-start gap-2">
                    <Checkbox
                      checked={preserveManualLocks}
                      onCheckedChange={(checked) => setPreserveManualLocks(Boolean(checked))}
                    />
                    <span>
                      Preserve manual assignments
                      <span className="block text-xs text-slate-500">Keep manual rows locked when rerunning.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2">
                    <Checkbox
                      checked={allowNoAvailabilityAfpPlaceholders}
                      onCheckedChange={(checked) => setAllowNoAvailabilityAfpPlaceholders(Boolean(checked))}
                    />
                    <span>
                      Enable no-availability AFP placeholders
                      <span className="block text-xs text-slate-500">
                        Only shifts nobody selected; marked separately in stats/export.
                      </span>
                    </span>
                  </label>
                </div>
                {allowNoAvailabilityAfpPlaceholders && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {(responses ?? [])
                      .filter((response) => response.category === "AFP")
                      .map((response) => (
                        <label
                          key={response.respondentId}
                          className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2"
                        >
                          <Checkbox
                            checked={noAvailabilityFallbackAfpIds.has(response.respondentId)}
                            onCheckedChange={() => toggleNoAvailabilityFallbackAfp(response.respondentId)}
                          />
                          <span className="font-medium text-slate-800">{displayRespondentName(response)}</span>
                        </label>
                      ))}
                  </div>
                )}
              </div>

              {allocationSnapshots.length > 0 && (
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
                    <History className="h-4 w-4 text-slate-500" />
                    <h3 className="font-bold text-slate-900">Recovery Points</h3>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {allocationSnapshots.slice(0, 6).map((snapshot) => (
                      <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{snapshot.label}</p>
                          <p className="text-xs text-slate-500">
                            {format(new Date(snapshot.createdAt), "MMM d, yyyy h:mm a")}
                            {" · "}
                            {snapshot.allocationCount} assignments
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={restoreAllocationSnapshotMutation.isPending}
                          onClick={() => void handleRestoreAllocationSnapshot(snapshot)}
                        >
                          <Undo2 className="mr-1 h-4 w-4" />
                          Restore
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {dryRunAllocationMutation.data && (
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4 text-sm shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-indigo-950">Dry-Run Audit</h3>
                      <p className="text-indigo-700">No saved allocation or survey response data was changed.</p>
                    </div>
                    <Badge variant="outline" className="border-indigo-300 bg-white text-indigo-700">
                      {dryRunAllocationMutation.data.assignedShifts}/{dryRunAllocationMutation.data.totalShifts}{" "}
                      assigned
                    </Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div>
                      <p className="text-xs text-indigo-700/80">Blank with availability</p>
                      <p className="font-bold">{dryRunAllocationMutation.data.blankWithAvailabilityCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-indigo-700/80">Blank zero availability</p>
                      <p className="font-bold">{dryRunAllocationMutation.data.blankZeroAvailabilityShiftCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-indigo-700/80">AFP placeholders</p>
                      <p className="font-bold">
                        {dryRunAllocationMutation.data.allowedNoAvailabilityAfpPlaceholderAssignments}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-indigo-700/80">Illegal unavailable</p>
                      <p className="font-bold">{dryRunAllocationMutation.data.illegalAssignmentsWithoutAvailability}</p>
                    </div>
                    <div>
                      <p className="text-xs text-indigo-700/80">Comparable-pool mean</p>
                      <p className="font-bold">
                        {dryRunAllocationMutation.data.nonPenalizedGeneralMeanHours.toFixed(1)} hrs
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-indigo-700/80">Comparable-pool std dev</p>
                      <p className="font-bold">
                        {dryRunAllocationMutation.data.nonPenalizedGeneralStdDevHours.toFixed(2)} hrs
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-indigo-700/80">Optimizer</p>
                      <p className="font-bold">
                        {dryRunAllocationMutation.data.optimizationMethod === "global_milp"
                          ? dryRunAllocationMutation.data.optimizerStatus === "optimal"
                            ? "Global exact"
                            : "Global bounded"
                          : "Fallback"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-indigo-700/80">B2B pair-days</p>
                      <p className="font-bold">{dryRunAllocationMutation.data.backToBackPairDays}</p>
                    </div>
                  </div>
                  <DryRunRespondentPlanTable plans={dryRunAllocationMutation.data.respondentPlans} />
                </div>
              )}

              {showCalendar && survey.shifts && (
                <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-4">
                  <ExcelScheduleCalendar
                    ref={calendarRef}
                    title={survey.title}
                    month={survey.month}
                    year={survey.year}
                    allocations={allocations.allocations.map((a) => ({
                      respondentId: a.respondentId,
                      name: a.name,
                      category: a.category,
                      allocatedShifts: a.allocatedShifts,
                      totalHours: a.totalHours,
                    }))}
                    shifts={survey.shifts}
                  />
                </div>
              )}

              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-4">Respondent</th>
                      <th className="px-6 py-4">Assigned Shifts</th>
                      <th className="px-6 py-4">Total Hours</th>
                      <th className="px-6 py-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {allocations.allocations.map((a) => (
                      <tr key={a.respondentId} className="hover:bg-slate-50">
                        <td className="px-6 py-4">
                          <div className="font-medium text-slate-900">{a.name}</div>
                          <Badge
                            variant="outline"
                            className={clsx(
                              "mt-1 text-[10px] px-1.5 py-0 h-4",
                              a.category === "AFP"
                                ? "border-indigo-200 text-indigo-700 bg-indigo-50"
                                : "border-slate-200 text-slate-600 bg-slate-50",
                            )}
                          >
                            {a.category}
                          </Badge>
                          {a.isManuallyAdjusted && (
                            <Badge
                              variant="secondary"
                              className="mt-1 ml-1 bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0 h-4 border-none"
                            >
                              Adjusted
                            </Badge>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap gap-2">
                            {a.allocatedShifts.map((s) => (
                              <span
                                key={s.shiftId}
                                className={clsx(
                                  "inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium",
                                  s.isManual
                                    ? "bg-amber-100 text-amber-800"
                                    : s.isEmergency
                                      ? "bg-rose-100 text-rose-800"
                                      : isPlaceholderSource(s.assignmentSource)
                                        ? "bg-indigo-100 text-indigo-800"
                                        : "bg-slate-100 text-slate-700",
                                )}
                                title={s.assignmentSource}
                              >
                                {formatShiftLabelText(s.label)}
                              </span>
                            ))}
                            {a.allocatedShifts.length === 0 && <span className="text-slate-400 italic">None</span>}
                          </div>
                        </td>
                        <td className="px-6 py-4 font-bold text-slate-700">{a.totalHours} hrs</td>
                        <td className="px-6 py-4 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50"
                            onClick={() => {
                              setAdjustTarget(a.respondentId);
                              setAdjustShiftIds(new Set(a.allocatedShifts.map((s) => s.shiftId)));
                              setAdjustNoAvailabilityPlaceholder(false);
                            }}
                          >
                            <Settings className="w-4 h-4 mr-1" /> Adjust
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Post-Alloc Stats Tab */}
        <TabsContent value="alloc-stats" className="animate-in fade-in duration-300">
          {hasExistingAllocations && allocStats && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Overall Average</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {allocStats.averageHours.toFixed(1)} <span className="text-sm text-slate-400 font-normal">hrs</span>
                  </p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Median Hours</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {allocStats.medianHours.toFixed(1)} <span className="text-sm text-slate-400 font-normal">hrs</span>
                  </p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Overall Std Dev</p>
                  <p className="text-2xl font-bold text-slate-900">{allocStats.stdDev.toFixed(2)}</p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Total Allocated</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {allocStats.totalAllocatedHours.toFixed(1)}{" "}
                    <span className="text-sm text-slate-400 font-normal">hrs</span>
                  </p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Blank Shifts</p>
                  <p className="text-2xl font-bold text-slate-900">{allocStats.blankShiftCount}</p>
                  <p className="mt-1 text-xs text-rose-600">{allocStats.blankWithAvailabilityCount} had availability</p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">No-Availability Blanks</p>
                  <p className="text-2xl font-bold text-slate-900">{allocStats.noAvailabilityBlankCount}</p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">AFP Placeholders</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {allocStats.allowedNoAvailabilityAfpPlaceholderAssignments}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {allocStats.afpNoAvailabilityPlaceholderHours.toFixed(1)} hrs marked separately
                  </p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Back-to-Back Emergency</p>
                  <p className="text-2xl font-bold text-slate-900">{allocStats.backToBackEmergencyCount}</p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Illegal Unavailable Assignments</p>
                  <p
                    className={clsx(
                      "text-2xl font-bold",
                      allocStats.illegalAssignmentsWithoutAvailability > 0 ? "text-rose-700" : "text-slate-900",
                    )}
                  >
                    {allocStats.illegalAssignmentsWithoutAvailability}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Expected 0; AFP placeholders are counted separately</p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">AFP Cap Overflow</p>
                  <p className="text-2xl font-bold text-slate-900">{allocStats.afpCapOverflowCount}</p>
                  <p className="mt-1 text-xs text-slate-500">Only if AFP selected the shift</p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Manual Assignments</p>
                  <p className="text-2xl font-bold text-slate-900">{allocStats.manualAssignmentCount}</p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Rendered Assigned Blanks</p>
                  <p
                    className={clsx(
                      "text-2xl font-bold",
                      allocStats.renderedBlankButAssignedCount > 0 ? "text-rose-700" : "text-slate-900",
                    )}
                  >
                    {allocStats.renderedBlankButAssignedCount}
                  </p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Hard Same-Day Issues</p>
                  <p
                    className={clsx(
                      "text-2xl font-bold",
                      allocStats.nonAdjacentSameDayDoubleCount + allocStats.tripleShiftDayCount > 0
                        ? "text-rose-700"
                        : "text-slate-900",
                    )}
                  >
                    {allocStats.nonAdjacentSameDayDoubleCount + allocStats.tripleShiftDayCount}
                  </p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Min Hours</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {allocStats.minHours} <span className="text-sm text-slate-400 font-normal">hrs</span>
                  </p>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <p className="text-sm font-medium text-slate-500 mb-1">Max Hours</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {allocStats.maxHours} <span className="text-sm text-slate-400 font-normal">hrs</span>
                  </p>
                </div>
              </div>
              <div
                className={clsx(
                  "rounded-2xl border p-5 shadow-sm",
                  allocStats.fairnessWarning ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-slate-900">Fairness Diagnostics</h3>
                    <p className="mt-1 text-sm text-slate-600">
                      Comparable General pool standard-deviation target:{" "}
                      {allocStats.fairnessTargetStdDevHours.toFixed(1)} hrs; warning:{" "}
                      {allocStats.fairnessWarningStdDevHours.toFixed(1)} hrs. Strike-adjusted and availability-limited
                      respondents are excluded from this raw-spread comparison but remain covered by target residuals.
                    </p>
                    {allocStats.fairnessHighStdDevReason && (
                      <p className="mt-2 text-sm font-medium text-amber-800">{allocStats.fairnessHighStdDevReason}</p>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className={clsx(
                      "rounded-md bg-white",
                      allocStats.fairnessWarning
                        ? "border-amber-400 text-amber-800"
                        : "border-emerald-300 text-emerald-700",
                    )}
                  >
                    {allocStats.fairnessWarning ? "High Spread Warning" : "Spread OK"}
                  </Badge>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Comparable Mean</p>
                    <p className="text-lg font-bold">{allocStats.nonPenalizedGeneralMeanHours.toFixed(1)} hrs</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Comparable Std Dev</p>
                    <p className="text-lg font-bold">{allocStats.nonPenalizedGeneralStdDevHours.toFixed(2)} hrs</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Comparable Range</p>
                    <p className="text-lg font-bold">{allocStats.nonPenalizedGeneralRangeHours.toFixed(1)} hrs</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Repair Moves</p>
                    <p className="text-lg font-bold">{allocStats.fairnessRepairMoveCount}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Max From Mean</p>
                    <p className="text-lg font-bold">{allocStats.maxDeviationFromMeanHours.toFixed(1)} hrs</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Max From Target</p>
                    <p className="text-lg font-bold">{allocStats.maxDeviationFromTargetHours.toFixed(1)} hrs</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Squared Deviation</p>
                    <p className="text-lg font-bold">{allocStats.sumSquaredDeviationFromTargetHours.toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Repair Attempted</p>
                    <p className="text-lg font-bold">{allocStats.fairnessRepairAttempted ? "Yes" : "No"}</p>
                  </div>
                </div>
              </div>
              <div className="grid gap-4 xl:grid-cols-3">
                <AllocationSummaryPanel
                  title="Comparable General Pool"
                  note="Excludes strike and availability-limited respondents; every General respondent remains in target-residual checks."
                  summary={generalAllocationSummary}
                />
                <AllocationSummaryPanel
                  title="Target Reduction (Strike)"
                  note="Each configured reduction is subtracted from that person's neutral no-strike target."
                  summary={penalizedAllocationSummary}
                />
                <AllocationSummaryPanel
                  title="AFP Allocation"
                  note="All AFP respondents are shown here; only those explicitly enabled in Responses use an hours cap."
                  summary={afpAllocationSummary}
                />
              </div>
              {allocStats.penalizedStats.length > 0 && (
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mt-4">
                  <div className="p-4 border-b border-slate-100 bg-slate-50/50">
                    <h3 className="font-bold text-slate-900">Strike Target Reduction Check</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      The adjusted target is the neutral no-strike share minus the configured reduction. Coverage can
                      force the final allocation above that target.
                    </p>
                  </div>
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 font-medium">
                      <tr>
                        <th className="px-6 py-3">Name</th>
                        <th className="px-6 py-3">Reduction</th>
                        <th className="px-6 py-3">Neutral target</th>
                        <th className="px-6 py-3">Adjusted target</th>
                        <th className="px-6 py-3">Allocated</th>
                        <th className="px-6 py-3">Actual reduction</th>
                        <th className="px-6 py-3">From target</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {allocStats.penalizedStats.map((s) => (
                        <tr key={s.respondentId}>
                          <td className="px-6 py-3 font-medium text-slate-900">{s.name}</td>
                          <td className="px-6 py-3">{s.penaltyHours.toFixed(1)} hrs</td>
                          <td className="px-6 py-3">{s.neutralTargetHours.toFixed(1)} hrs</td>
                          <td className="px-6 py-3">{s.targetHours.toFixed(1)} hrs</td>
                          <td className="px-6 py-3 font-bold">{s.totalHours.toFixed(1)} hrs</td>
                          <td className="px-6 py-3">{s.penaltyGapHours.toFixed(1)} hrs</td>
                          <td className="px-6 py-3">
                            {s.deviationFromTargetHours >= 0 ? "+" : ""}
                            {s.deviationFromTargetHours.toFixed(1)} hrs
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {blankShiftExplanations.length > 0 && (
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mt-4">
                  <div className="p-4 border-b border-slate-100 bg-slate-50/50">
                    <h3 className="font-bold text-slate-900">Blank Shift Explanations</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      Blank shifts with availability are highlighted because the engine could not find a legal
                      assignment under the same-day and cap rules.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-slate-50 text-slate-500 font-medium">
                        <tr>
                          <th className="px-6 py-3">Shift</th>
                          <th className="px-6 py-3">Availability</th>
                          <th className="px-6 py-3">Reason</th>
                          <th className="px-6 py-3">Available People / Blockers</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {blankShiftExplanations.map((blank) => (
                          <tr key={blank.shiftId} className={blank.availabilityCount > 0 ? "bg-rose-50/50" : undefined}>
                            <td className="px-6 py-3 font-medium text-slate-900">
                              {formatShiftDisplay(blank)}
                              <div className="text-xs text-slate-500">{blank.durationHours} hrs</div>
                            </td>
                            <td className="px-6 py-3">{blank.availabilityCount}</td>
                            <td className="px-6 py-3">
                              <Badge variant="outline" className="border-slate-200 bg-white text-slate-700">
                                {blank.reasonCategory}
                              </Badge>
                              <div className="mt-1 text-xs text-slate-500">{blank.explanationText}</div>
                            </td>
                            <td className="px-6 py-3 text-xs text-slate-600">
                              {blank.availableRespondents.length > 0 ? (
                                <div className="space-y-1">
                                  {blank.availableRespondents.map((respondent) => (
                                    <div key={respondent.respondentId}>
                                      <span className="font-medium text-slate-800">{respondent.name}</span>
                                      {" - "}
                                      {respondent.blockers.join(", ")}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-slate-400">No one selected this shift.</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mt-4">
                <div className="p-4 border-b border-slate-100 bg-slate-50/50">
                  <h3 className="font-bold text-slate-900">Per-Respondent Analysis</h3>
                </div>
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 text-slate-500 font-medium">
                    <tr>
                      <th className="px-6 py-3">Name</th>
                      <th className="px-6 py-3">Category</th>
                      <th className="px-6 py-3">Total Hrs</th>
                      <th className="px-6 py-3">Weekday Shifts</th>
                      <th className="px-6 py-3">Weekend Shifts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {allocStats.respondentStats.map((s) => (
                      <tr key={s.respondentId}>
                        <td className="px-6 py-3 font-medium text-slate-900">
                          <button
                            className="underline decoration-dotted underline-offset-4 hover:text-indigo-700"
                            onClick={() => setSelectedRespondentId(s.respondentId)}
                          >
                            {s.name}
                          </button>
                        </td>
                        <td className="px-6 py-3">{s.category}</td>
                        <td className="px-6 py-3 font-bold">{s.totalHours}</td>
                        <td className="px-6 py-3 text-slate-600">{s.weekdayShifts}</td>
                        <td className="px-6 py-3 text-slate-600">{s.weekendShifts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="alloc-audit" className="animate-in fade-in duration-300">
          {hasExistingAllocations && allocationAudit.length > 0 && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h3 className="font-bold text-slate-900">Allocation Audit</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Every shift is listed with its stable key, assignment/rendering state, availability, and blockers.
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={downloadAuditCsv} className="rounded-xl">
                  <FileSpreadsheet className="w-4 h-4 mr-1" /> Download Audit CSV
                </Button>
              </div>
              <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
                <table className="w-full min-w-[1100px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Shift</th>
                      <th className="px-4 py-3">Stable Key</th>
                      <th className="px-4 py-3">Assigned</th>
                      <th className="px-4 py-3">Availability</th>
                      <th className="px-4 py-3">Eligible</th>
                      <th className="px-4 py-3">Reason</th>
                      <th className="px-4 py-3">Blockers</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {allocationAudit.map((row) => (
                      <tr
                        key={row.shiftId}
                        className={clsx(
                          row.allocationRecordExists && row.renderedCellIsBlank
                            ? "bg-rose-50"
                            : !row.allocationRecordExists && row.availabilityCount > 0
                              ? "bg-amber-50"
                              : undefined,
                        )}
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900">
                            {row.dayOfWeek}, {row.date}
                          </div>
                          <div className="text-xs text-slate-500">
                            {formatTime12(row.startTime)}-{formatTime12(row.endTime)}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-600">{row.stableShiftKey}</td>
                        <td className="px-4 py-3">
                          {row.allocationRecordExists ? (
                            <div>
                              <div className="font-medium text-slate-900">{row.assignedRespondentName}</div>
                              <div className="text-xs text-slate-500">{row.assignmentSource}</div>
                            </div>
                          ) : (
                            <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-700">
                              Blank
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3">{row.availabilityCount}</td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          Normal {row.eligibleNormalCandidateCount} | B2B{" "}
                          {row.eligibleBackToBackEmergencyCandidateCount}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="border-slate-200 bg-white text-slate-700">
                            {row.reasonCategory}
                          </Badge>
                          {row.renderedCellIsBlank && row.allocationRecordExists && (
                            <div className="mt-1 text-xs font-medium text-rose-700">
                              Rendered blank despite allocation
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {row.availableRespondents.length > 0 ? (
                            <div className="space-y-1">
                              {row.availableRespondents.map((respondent) => (
                                <div key={respondent.respondentId}>
                                  <span className="font-medium text-slate-800">{respondent.name}</span>
                                  {": "}
                                  {respondent.blockers.length > 0 ? respondent.blockers.join(", ") : "eligible"}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-slate-400">No availability</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog
        open={selectedResponse !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedResponse(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Availability Details: {selectedResponse ? displayRespondentName(selectedResponse) : ""}
            </DialogTitle>
          </DialogHeader>
          {selectedResponse && (
            <div className="space-y-4">
              <div className="grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700">Full name</label>
                  <Input
                    value={selectedName}
                    onChange={(event) => setSelectedName(event.target.value)}
                    className="h-9 rounded-md"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700">Preferred name</label>
                  <Input
                    value={selectedPreferredName}
                    onChange={(event) => setSelectedPreferredName(event.target.value)}
                    className={clsx(
                      "h-9 rounded-md",
                      isEmailLike(selectedPreferredName) && "border-destructive bg-rose-50/70",
                    )}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700">Email</label>
                  <Input
                    type="email"
                    value={selectedEmail}
                    onChange={(event) => setSelectedEmail(event.target.value)}
                    className="h-9 rounded-md"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700">Category</label>
                  <Select
                    value={selectedCategory}
                    onValueChange={(value: "AFP" | "General") => {
                      setSelectedCategory(value);
                      if (value !== "AFP") setSelectedHasAfpCap(false);
                    }}
                  >
                    <SelectTrigger className="h-9 rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="General">Non-Ambassador Fellow</SelectItem>
                      <SelectItem value="AFP">Ambassador Fellow (AFP)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {isEmailLike(selectedPreferredName) && (
                  <p className="text-xs font-medium text-destructive sm:col-span-2">
                    Preferred name should be a name, not an email.
                  </p>
                )}
                <div className="flex justify-end sm:col-span-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={saveSelectedRespondentDetails}
                    disabled={
                      updateRespondentMutation.isPending || !selectedName.trim() || isEmailLike(selectedPreferredName)
                    }
                  >
                    {updateRespondentMutation.isPending ? "Saving..." : "Save Details"}
                  </Button>
                </div>
              </div>
              <p className="text-sm text-slate-600">
                Selected shifts: <strong>{selectedShiftIds.size}</strong> | Total available hours:{" "}
                <strong>{editedSelectedHours}</strong>
              </p>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                Checked shifts are this respondent&apos;s saved availability. Click any row to add or remove shifts,
                then save. If their <strong>Use</strong> box stays checked, allocation will use this saved set directly.
              </div>
              <div className="grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-2">
                <label className="flex items-center gap-3 text-sm text-slate-700">
                  <Checkbox
                    checked={selectedHasPenalty}
                    onCheckedChange={(checked) => {
                      const enabled = checked === true;
                      setSelectedHasPenalty(enabled);
                      setSelectedPenaltyHours(enabled ? Math.max(1, selectedPenaltyHours) : 0);
                    }}
                  />
                  Strike target reduction
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  Deduct
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    value={selectedPenaltyHours}
                    disabled={!selectedHasPenalty}
                    onChange={(event) => setSelectedPenaltyHours(Math.max(0, Number(event.target.value || 0)))}
                    className="h-8 w-20 rounded-md"
                  />
                  hours
                </label>
                <p className="text-xs text-slate-500 sm:col-span-2">
                  Subtracts these hours from the neutral equal-allocation target. This is not an hours cap.
                </p>
                {selectedCategory === "AFP" && (
                  <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <Checkbox
                        checked={selectedHasAfpCap}
                        onCheckedChange={(checked) => setSelectedHasAfpCap(checked === true)}
                      />
                      Add AFP cap
                    </label>
                    {selectedHasAfpCap && (
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        Cap
                        <Input
                          type="number"
                          min={0}
                          step={0.5}
                          value={selectedAfpHoursCap}
                          onChange={(event) => setSelectedAfpHoursCap(Math.max(0, Number(event.target.value || 0)))}
                          className="h-8 w-20 rounded-md"
                        />
                        hours for this survey
                      </label>
                    )}
                  </div>
                )}
              </div>
              <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 p-3">
                <div className="flex justify-end gap-2 pb-3 mb-3 border-b border-slate-200">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedShiftIds(new Set((survey.shifts || []).map((shift) => shift.id)))}
                  >
                    Select all
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedShiftIds(new Set())}>
                    Clear all
                  </Button>
                </div>
                {(survey.shifts || []).map((shift) => (
                  <button
                    key={shift.id}
                    type="button"
                    onClick={() => toggleSelectedShift(shift.id)}
                    className={clsx(
                      "w-full text-sm py-2 px-2 border-b last:border-0 rounded-md flex items-center gap-3 text-left transition-colors",
                      selectedShiftIds.has(shift.id) ? "bg-primary/10" : "hover:bg-slate-50",
                    )}
                  >
                    <Checkbox checked={selectedShiftIds.has(shift.id)} className="pointer-events-none" />
                    <span>
                      {formatShiftDisplay(shift)} ({shift.durationHours} hours)
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    await updateResponseMutation.mutateAsync({
                      surveyId,
                      respondentId: selectedResponse.respondentId,
                      selectedShiftIds: Array.from(selectedShiftIds),
                      hasPenalty: selectedHasPenalty,
                      penaltyHours: selectedHasPenalty ? selectedPenaltyHours : 0,
                      hasAfpCap: selectedCategory === "AFP" && selectedHasAfpCap,
                      afpHoursCap: selectedAfpHoursCap,
                    });
                    setSelectedResponse(null);
                  }}
                >
                  Save Shift Changes
                </Button>
                <Button
                  variant="destructive"
                  onClick={async () => {
                    if (!confirm(`Move ${displayRespondentName(selectedResponse)}'s response to Deleted?`)) {
                      return;
                    }
                    try {
                      await deleteResponseMutation.mutateAsync({
                        surveyId,
                        respondentId: selectedResponse.respondentId,
                      });
                      setSelectedResponse(null);
                    } catch (error) {
                      alert(error instanceof Error ? error.message : "Failed to delete response");
                    }
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Move to Deleted
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedRespondentId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedRespondentId(null);
        }}
      >
        <DialogContent className="max-h-[86vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {respondentHistory ? `${respondentHistory.respondent.name} - Front Desk History` : "Respondent history"}
            </DialogTitle>
          </DialogHeader>

          {!respondentHistory ? (
            <div className="py-8 text-center text-slate-500">Loading history...</div>
          ) : (
            <RespondentHistoryPanel history={respondentHistory} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={statsShift !== null} onOpenChange={(open) => !open && setStatsShift(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Selected Respondents: {statsShift?.label}</DialogTitle>
          </DialogHeader>
          <div className="max-h-80 overflow-auto rounded-lg border border-slate-200 p-3">
            {statsShift?.names.length ? (
              statsShift.names.map((name) => (
                <div key={name} className="text-sm py-1 border-b last:border-0">
                  {name}
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">No respondents selected this shift.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={adjustTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAdjustTarget(null);
            setAdjustNoAvailabilityPlaceholder(false);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Adjust Allocated Shifts</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {allocations?.allocations.find((allocation) => allocation.respondentId === adjustTarget)?.category ===
              "AFP" && (
              <label className="flex items-start gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 p-3 text-sm">
                <Checkbox
                  checked={adjustNoAvailabilityPlaceholder}
                  onCheckedChange={(checked) => setAdjustNoAvailabilityPlaceholder(Boolean(checked))}
                />
                <span>
                  Assign zero-availability AFP placeholder
                  <span className="block text-xs text-indigo-700">
                    Use only for shifts where no one selected availability. Ordinary manual assignments still require
                    selected availability.
                  </span>
                </span>
              </label>
            )}
            <div className="max-h-80 overflow-auto rounded-lg border border-slate-200 p-3">
              {(survey.shifts || []).map((shift) => (
                <label key={shift.id} className="text-sm py-2 border-b last:border-0 flex items-center gap-3">
                  <Checkbox
                    checked={adjustShiftIds.has(shift.id)}
                    onCheckedChange={() => {
                      const next = new Set(adjustShiftIds);
                      if (next.has(shift.id)) next.delete(shift.id);
                      else next.add(shift.id);
                      setAdjustShiftIds(next);
                    }}
                  />
                  <span>
                    {formatShiftDisplay(shift)}
                    {(availabilityCountByShiftId.get(shift.id) ?? 0) === 0 && (
                      <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                        no availability
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end">
              <Button
                onClick={async () => {
                  if (adjustTarget === null) return;
                  const existing = allocations?.allocations.find((a) => a.respondentId === adjustTarget);
                  const existingIds = new Set(existing?.allocatedShifts.map((s) => s.shiftId) ?? []);
                  const nextIds = Array.from(adjustShiftIds);
                  const shiftIdsToAdd = nextIds.filter((id) => !existingIds.has(id));
                  const shiftIdsToRemove = Array.from(existingIds).filter((id) => !adjustShiftIds.has(id));
                  await adjustAllocationMutation.mutateAsync({
                    id: surveyId,
                    data: {
                      respondentId: adjustTarget,
                      shiftIdsToAdd,
                      shiftIdsToRemove,
                      noAvailabilityAfpPlaceholder: adjustNoAvailabilityPlaceholder,
                    },
                  });
                  setAdjustTarget(null);
                  setAdjustNoAvailabilityPlaceholder(false);
                }}
              >
                Save Allocation Adjustments
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
