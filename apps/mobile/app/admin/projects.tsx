import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  describeImpact,
  groupsOf,
  impactIsDestructive,
  maskToGroups,
  type AdminProjectDto,
} from '@gct/shared';
import {
  ApiError,
  apiAdminDeleteProject,
  apiAdminProjectImpact,
  apiAdminProjects,
} from '../../src/api/client';
import { confirmAction } from '../../src/ui/confirm';
import {
  Card,
  ErrorState,
  ErrorText,
  Field,
  LoadingState,
  Notice,
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
  /**
   * The project whose delete is waiting for its number to be typed, and what it would
   * destroy. Asked in the card itself rather than in a prompt: a browser prompt cannot
   * put the dashes in as you type, and Android has no text prompt at all — it fell back
   * to a plain OK, which is exactly the reflex this check exists to stop.
   */
  const [confirming, setConfirming] = useState<{ id: string; summary: string } | null>(null);
  const [typed, setTyped] = useState('');

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

    if (summary) {
      // Destroys evidence: the number has to be typed first — see `confirming`.
      setTyped('');
      setConfirming({ id: project.id, summary });
      return;
    }
    if (
      await confirmAction(`Delete ${project.projectNumber}? Nothing has been delivered on it yet.`)
    ) {
      await destroy(project);
    }
  };

  const destroy = async (project: AdminProjectDto) => {
    setConfirming(null);
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

          {confirming?.id === p.id ? (
            <DeleteConfirm
              projectNumber={p.projectNumber}
              clientName={p.clientName}
              summary={confirming.summary}
              typed={typed}
              onType={setTyped}
              onDelete={() => void destroy(p)}
              onCancel={() => setConfirming(null)}
            />
          ) : (
            <Pressable
              disabled={busyId === p.id}
              onPress={() => void remove(p)}
              style={{ paddingVertical: 10 }}
            >
              <Text style={{ color: colors.danger, fontWeight: '600' }}>
                {busyId === p.id ? 'Working…' : 'Delete this project'}
              </Text>
            </Pressable>
          )}
        </Card>
      ))}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}

/**
 * "Type the project number to delete it" — in the card, with the dashes put in as you
 * type. The field takes the SHAPE of the number on record, so a project recorded in the
 * old 6-3-1-2 format can still be deleted; a free-text number from before any format
 * is typed as-is. Nothing is deleted until what is typed matches exactly.
 */
function DeleteConfirm({
  projectNumber,
  clientName,
  summary,
  typed,
  onType,
  onDelete,
  onCancel,
}: {
  projectNumber: string;
  clientName: string;
  summary: string;
  typed: string;
  onType: (v: string) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const groups = groupsOf(projectNumber);
  const matches = typed.trim() === projectNumber;
  return (
    <View style={{ gap: 8, marginTop: 6 }}>
      <Notice tone="danger" title={`Deleting ${projectNumber} destroys ${summary}.`}>
        {`${clientName} and their locations stay — only this job and its deliveries go, ` +
          'including any signed delivery notes. This cannot be undone.'}
      </Notice>
      <Field
        label={`Type ${projectNumber} to confirm`}
        value={typed}
        onChangeText={(t) => onType(groups ? maskToGroups(t, groups) : t)}
        placeholder={projectNumber}
        keyboardType={groups ? 'number-pad' : 'default'}
        inputMode={groups ? 'numeric' : 'text'}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={{ flexDirection: 'row', gap: 18, alignItems: 'center' }}>
        <Pressable disabled={!matches} onPress={onDelete} style={{ paddingVertical: 10 }}>
          <Text
            style={{
              color: matches ? colors.danger : colors.inkFaint,
              fontWeight: '700',
            }}
          >
            Delete permanently
          </Text>
        </Pressable>
        <Pressable onPress={onCancel} style={{ paddingVertical: 10 }}>
          <Text style={{ color: colors.brand, fontWeight: '600' }}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
