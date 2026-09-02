import { ScanStep } from '../../src/scanning/ScanStep';

export default function TransferScan() {
  return (
    <ScanStep
      next="/transfer/photo"
      home="/transfer"
      ctaLabel={(n) => `Photograph the batch (${n})`}
    />
  );
}
