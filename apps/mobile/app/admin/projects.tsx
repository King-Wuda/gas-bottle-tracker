import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { describeImpact, impactIsDestructive, type AdminProjectDto } from '@gct/shared';
import {
  ApiError,
  apiAdminDeleteProject,
  apiAdminProjectImpact,
  apiAdminProjects,
} from '../../src/api/client';
import { confirmAction, confirmByTyping } from '../../src/ui/confirm';
import {
  Card,
  ErrorState,
  ErrorText,
  LoadingState,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';
import { StatusBadge } from '../../src/ui/controls';
import { colors } from '../../src/ui/theme';

/**
 * Jobs, and deleting one along with its deliveries.
 *
 * Deliberately not on the Clients screen. A client and its locations are reference
 * data an admin edits without consequence — a typo corrected, a site added. A project
 * carries batches, cylinders, the movement log and signed delivery notes, and deleting
 * one destroys them. Putting both on one page would sit the irreversible control next
 * to the routine one and rely on the label to keep them apart.
 *
 * There is no "create" here: a project is started from the New Batch flow, where the
 * project number is validated against the format the depot actually uses. A second
 * creation path would be a second set of rules to keep in step.
 */
export default function AdminProjects() {
  const [projects, setProjects] = useState<AdminProjectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiAdminProjects();
      setProjects(res.projects);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load projects.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (project: AdminProjectDto) => {
    setBusyId(project.id);
    setActionError(null);
    let summary: string | null;
    try {
      const { impact } = await apiAdminProjectImpact(project.id);
      summary = impactIsDestructive(impact) ? describeImpact(impact) : null;
    } catch (e) {
      setBusyId(null);
      setActionError(e instanceof ApiError ? e.message : 'Could not check what this would delete.');
      return;
    }
    setBusyId(null);

    const ok = summary
      ? await confirmByTyping(
          `Deleting ${project.projectNumber} will permanently destroy ${summary}.\n\n` +
            `${project.clientName} and their locations stay — only this job and its ` +
            `deliveries go, including any signed delivery notes.\n\n` +
            `This cannot be undone. Type ${project.projectNumber} to confirm.`,
          project.projectNumber,
        )
      : await confirmAction(
          `Delete ${project.projectNumber}? Nothing has been delivered on it yet.`,
        );
    if (!ok) return;

    setBusyId(project.id);
    setActionError(null);
    try {
      await apiAdminDeleteProject(project.id);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not delete this project.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && projects.length === 0) return <LoadingState label="Loading projects…" />;
  if (loadError && projects.length === 0) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        Every job on record. Deleting one destroys its batches and delivery notes — the client and
        their locations are untouched.
      </Text>

      {actionError ? <ErrorText>{actionError}</ErrorText> : null}

      {projects.length === 0 ? (
        <Card>
          <Text>No projects yet.</Text>
          <Text style={styles.hint}>One is started with its first batch, on the New screen.</Text>
        </Card>
      ) : null}

      {projects.map((p) => (
        <Card key={p.id}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text style={{ fontSize: 17, fontWeight: '700', flexShrink: 1 }}>
              {p.projectNumber}
            </Text>
            <StatusBadge
              label={p.status === 'ACTIVE' ? 'Active' : 'Closed'}
              tone={p.status === 'ACTIVE' ? 'neutral' : 'done'}
            />
          </View>
          <Text style={styles.hint}>
            {p.clientName} · {p.projectManagerName} · {p.batchCount} batch
            {p.batchCount === 1 ? '' : 'es'}
          </Text>

          <Pressable
            disabled={busyId === p.id}
            onPress={() => void remove(p)}
            style={{ paddingVertical: 10 }}
          >
            <Text style={{ color: colors.danger, fontWeight: '600' }}>
              {busyId === p.id ? 'Working…' : 'Delete this project'}
            </Text>
          </Pressable>
        </Card>
      ))}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
