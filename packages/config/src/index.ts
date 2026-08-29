export const product = {
  name: 'PledgeDrive',
  tagline: "Your cloud. Powered by everyone's spare storage.",
  defaultQuotaBytes: 5 * 1024 ** 3,
  replicationFactor: 3,
  chunkSizeBytes: 4 * 1024 * 1024,
  creditRates: { utilizedGbMonth: 1, servedGb: 0.05 },
  storagePolicy: { mobileReliabilityClass: 'C', desktopReliabilityClass: 'A', reductionGraceHours: 72 }
} as const;
