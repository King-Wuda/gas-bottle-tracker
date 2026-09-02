import { ScanStep } from '../../src/scanning/ScanStep';

export default function ReturnsScan() {
  return (
    <ScanStep
      next="/returns/photo"
      home="/returns"
      ctaLabel={(n) => `Photograph the batch (${n})`}
    />
  );
}
