import { Text, View } from 'react-native';
import { summariseDistribution, type BatchDistributionEntry, type BatchLineDto } from '@gct/shared';
import { styles } from '../ui/components';

/**
 * What a batch holds, and where each gas in it currently is.
 *
 * The second half is the point. A batch used to be one gas in one place, so a row
 * could honestly say "7 × Nitrogen at Yard B". Partial movement broke that: 3 of the 7
 * can be at stores while 4 are on site, and a single-location line would be a claim
 * the system cannot support. So every gas gets its own split, spelled out.
 *
 * Rendered identically in the Transfer, Returns and History lists and on the batch
 * detail screen — the same fact should not have three phrasings.
 */
export function BatchContents({
  lines,
  distribution,
  /** Detail view shows every line; a list row keeps to the first few. */
  compact = false,
}: {
  lines: BatchLineDto[];
  distribution: BatchDistributionEntry[];
  compact?: boolean;
}) {
  const shown = compact ? lines.slice(0, 3) : lines;
  const hidden = lines.length - shown.length;

  return (
    <View style={{ gap: 3 }}>
      {shown.map((line) => {
        const here = distribution.filter((d) => d.gasTypeId === line.gasTypeId);
        return (
          <View key={line.id}>
            <Text>
              <Text style={{ fontWeight: '700' }}>
                {line.quantity} × {line.gasTypeName}
              </Text>
              <Text style={{ opacity: 0.7 }}>
                {'  '}
                {line.supplierName}
              </Text>
            </Text>
            {here.length > 0 ? (
              <Text style={styles.hint}>{summariseDistribution(here)}</Text>
            ) : null}
          </View>
        );
      })}
      {hidden > 0 ? (
        <Text style={styles.hint}>
          +{hidden} more line{hidden === 1 ? '' : 's'}
        </Text>
      ) : null}
    </View>
  );
}
