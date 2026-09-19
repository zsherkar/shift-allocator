import { useQueryClient } from "@tanstack/react-query";
import {
  useRunAllocation as useGeneratedRunAllocation,
  useDryRunAllocation as useGeneratedDryRunAllocation,
  useAdjustAllocation as useGeneratedAdjustAllocation,
  useRestoreAllocationSnapshot as useGeneratedRestoreAllocationSnapshot,
  useGetAllocations,
  useGetAllocationSnapshots,
  useGetAllocationStats,
  getGetAllocationsQueryKey,
  getGetAllocationSnapshotsQueryKey,
  getGetAllocationStatsQueryKey,
} from "@workspace/api-client-react";

export { useGetAllocations, useGetAllocationSnapshots, useGetAllocationStats };

export function useRunAllocation() {
  const queryClient = useQueryClient();
  return useGeneratedRunAllocation({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({
          queryKey: getGetAllocationsQueryKey(variables.id),
        });
        queryClient.invalidateQueries({
          queryKey: getGetAllocationStatsQueryKey(variables.id),
        });
        queryClient.invalidateQueries({
          queryKey: getGetAllocationSnapshotsQueryKey(variables.id),
        });
      },
    },
  });
}

export function useDryRunAllocation() {
  return useGeneratedDryRunAllocation();
}

export function useAdjustAllocation() {
  const queryClient = useQueryClient();
  return useGeneratedAdjustAllocation({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({
          queryKey: getGetAllocationsQueryKey(variables.id),
        });
        queryClient.invalidateQueries({
          queryKey: getGetAllocationStatsQueryKey(variables.id),
        });
        queryClient.invalidateQueries({
          queryKey: getGetAllocationSnapshotsQueryKey(variables.id),
        });
      },
    },
  });
}

export function useRestoreAllocationSnapshot() {
  const queryClient = useQueryClient();
  return useGeneratedRestoreAllocationSnapshot({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({
          queryKey: getGetAllocationsQueryKey(variables.id),
        });
        queryClient.invalidateQueries({
          queryKey: getGetAllocationStatsQueryKey(variables.id),
        });
        queryClient.invalidateQueries({
          queryKey: getGetAllocationSnapshotsQueryKey(variables.id),
        });
      },
    },
  });
}
