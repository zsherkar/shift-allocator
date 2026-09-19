import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { 
  useCreateSurvey as useGeneratedCreateSurvey,
  useUpdateSurvey as useGeneratedUpdateSurvey,
  getListSurveysQueryKey,
  getGetSurveyQueryKey,
  getGetSurveyResponsesQueryKey,
  getGetSurveyStatsQueryKey,
  getGetAllocationsQueryKey,
  getGetAllocationStatsQueryKey,
  useListSurveys,
  useGetSurvey,
  useGetSurveyResponses,
  useGetSurveyStats,
} from "@workspace/api-client-react";

export { 
  useListSurveys, 
  useGetSurvey, 
  useGetSurveyResponses, 
  useGetSurveyStats 
};

export type DeletedSurveyResponse = {
  id: number;
  surveyId: number;
  respondentId: number;
  name: string;
  preferredName: string;
  email: string | null;
  category: string;
  selectedShiftIds: number[];
  hasPenalty: boolean;
  penaltyHours: number;
  hasAfpCap: boolean;
  afpHoursCap: number;
  allocationCount: number;
  deletedAt: string;
};

const getDeletedSurveyResponsesQueryKey = (surveyId: number) =>
  ["surveys", surveyId, "deleted-responses"] as const;

function invalidateSurveyResponseData(queryClient: ReturnType<typeof useQueryClient>, surveyId: number) {
  queryClient.invalidateQueries({ queryKey: getGetSurveyQueryKey(surveyId) });
  queryClient.invalidateQueries({ queryKey: getGetSurveyResponsesQueryKey(surveyId) });
  queryClient.invalidateQueries({ queryKey: getGetSurveyStatsQueryKey(surveyId) });
  queryClient.invalidateQueries({ queryKey: getGetAllocationsQueryKey(surveyId) });
  queryClient.invalidateQueries({ queryKey: getGetAllocationStatsQueryKey(surveyId) });
  queryClient.invalidateQueries({ queryKey: getDeletedSurveyResponsesQueryKey(surveyId) });
}

export function useDeletedSurveyResponses(surveyId: number) {
  return useQuery({
    queryKey: getDeletedSurveyResponsesQueryKey(surveyId),
    queryFn: async () => {
      const response = await fetch(`/api/surveys/${surveyId}/deleted-responses`);
      if (!response.ok) throw new Error("Failed to load deleted responses");
      return response.json() as Promise<DeletedSurveyResponse[]>;
    },
    enabled: Number.isInteger(surveyId) && surveyId > 0,
  });
}

export function useCreateSurvey() {
  const queryClient = useQueryClient();
  return useGeneratedCreateSurvey({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSurveysQueryKey() });
      }
    }
  });
}

export function useUpdateSurvey() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateSurvey({
    mutation: {
      onSuccess: (data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListSurveysQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetSurveyQueryKey(variables.id) });
      }
    }
  });
}

export function useDeleteSurvey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const response = await fetch(`/api/surveys/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete survey");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListSurveysQueryKey() });
    },
  });
}

export function useDeleteSurveyResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ surveyId, respondentId }: { surveyId: number; respondentId: number }) => {
      const response = await fetch(`/api/surveys/${surveyId}/responses/${respondentId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete response");
    },
    onSuccess: (_, variables) => {
      invalidateSurveyResponseData(queryClient, variables.surveyId);
    },
  });
}

export function useRestoreSurveyResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      surveyId,
      deletedResponseId,
    }: {
      surveyId: number;
      deletedResponseId: number;
    }) => {
      const response = await fetch(
        `/api/surveys/${surveyId}/deleted-responses/${deletedResponseId}/restore`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Failed to restore response");
      }
      return response.json() as Promise<{
        respondentId: number;
        restoredShiftCount: number;
        restoredAllocationCount: number;
        skippedAllocationCount: number;
      }>;
    },
    onSuccess: (_, variables) => {
      invalidateSurveyResponseData(queryClient, variables.surveyId);
    },
  });
}

export function useUpdateSurveyResponse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      surveyId,
      respondentId,
      selectedShiftIds,
      hasPenalty,
      penaltyHours,
      hasAfpCap,
      afpHoursCap,
    }: {
      surveyId: number;
      respondentId: number;
      selectedShiftIds: number[];
      hasPenalty?: boolean;
      penaltyHours?: number;
      hasAfpCap?: boolean;
      afpHoursCap?: number;
    }) => {
      const response = await fetch(`/api/surveys/${surveyId}/responses/${respondentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedShiftIds, hasPenalty, penaltyHours, hasAfpCap, afpHoursCap }),
      });
      if (!response.ok) throw new Error("Failed to update response");
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: getGetSurveyQueryKey(variables.surveyId) });
      queryClient.invalidateQueries({ queryKey: getGetSurveyResponsesQueryKey(variables.surveyId) });
      queryClient.invalidateQueries({ queryKey: getGetSurveyStatsQueryKey(variables.surveyId) });
      queryClient.invalidateQueries({ queryKey: getGetAllocationsQueryKey(variables.surveyId) });
      queryClient.invalidateQueries({ queryKey: getGetAllocationStatsQueryKey(variables.surveyId) });
    },
  });
}
