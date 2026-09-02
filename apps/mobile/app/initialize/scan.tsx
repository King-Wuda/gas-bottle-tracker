import { ScanStep } from '../../src/scanning/ScanStep';

export default function InitializeScan() {
  return (
    <ScanStep
      next="/initialize/photo"
      home="/initialize"
      // Every cylinder, or none: initialization is a claim about the batch as a unit,
      // and the server refuses a partial one. See ScanStep's `requireAll`.
      requireAll
      ctaLabel={(n) => `Photograph the batch (${n})`}
      incompleteLabel={(left) => `${left} cylinder(s) still to scan`}
    />
  );
}
