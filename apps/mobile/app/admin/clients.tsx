import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  describeImpact,
  impactIsDestructive,
  type AdminClientDto,
  type AdminClientLocationDto,
} from '@gct/shared';
import {
  ApiError,
  apiAdminClientImpact,
  apiAdminClients,
  apiAdminDeleteAllLocations,
  apiAdminDeleteClient,
  apiAdminDeleteLocation,
  apiAdminLocationImpact,
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
 * Clients and their locations — McCains, with Delmas, Cape Town and Durban under it.
 *
 * Underneath these are `Project` and `Site` rows. The app's own vocabulary grew from
 * the paperwork, where a project number identifies the job; nobody in the yard says
 * "project 4521-A", they say "McCains". This screen speaks the yard's language and the
 * project number rides along as the identifier it is.
 *
 * Everything here is destructive, and nothing here is reversible. Three scopes, in
 * ascending order of damage:
 *
 *  - **A location** takes the batches delivered to it.
 *  - **All locations** takes all of them, keeping the client so new sites can be added
 *    — the "they moved everything" case.
 *  - **The client** takes the lot, itself included.
 *
 * Adding is deliberately NOT here. A client is created by starting a project on the
 * New Batch flow, where the project number is validated against the format the depot
 * actually uses; a second creation path would be a second set of rules to keep in step.
 */
export default function AdminClients() {
  const router = useRouter();

  const [clients, setClients] = useState<AdminClientDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiAdminClients();
      setClients(res.clients);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load clients.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, action: () => Promise<unknown>, failure: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : failure);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Ask the server what a delete would cost, then put that number in front of the
   * admin before anything runs.
   *
   * Always a round trip rather than a guess from the batch counts already on screen:
   * those count batches, and the sentence that actually stops someone is the one with
   * the cylinders and the signed delivery notes in it. Returns null if the admin backs
   * out or the check fails.
   */
  const confirmDestructive = async (
    id: string,
    fetchImpact: () => Promise<{ impact: Parameters<typeof describeImpact>[0] }>,
    what: string,
    typeToConfirm: string,
    extra: string,
  ): Promise<boolean> => {
    setBusyId(id);
    setActionError(null);
    let summary: string | null;
    try {
      const { impact } = await fetchImpact();
      summary = impactIsDestructive(impact) ? describeImpact(impact) : null;
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not check what this would delete.');
      return false;
    } finally {
      setBusyId(null);
    }

    if (!summary) {
      return confirmAction(`Delete ${what}? Nothing has been booked against it yet.`);
    }
    return confirmByTyping(
      `Deleting ${what} will permanently destroy ${summary}.\n\n${extra}\n\n` +
        `This cannot be undone. Type ${typeToConfirm} to confirm.`,
      typeToConfirm,
    );
  };

  const removeLocation = async (client: AdminClientDto, site: AdminClientLocationDto) => {
    const ok = await confirmDestructive(
      client.id,
      () => apiAdminLocationImpact(client.id, site.id),
      `${site.name} (${client.projectNumber})`,
      site.name,
      'Cylinders from other batches parked at this location go back to Stores.',
    );
    if (!ok) return;
    await run(
      client.id,
      () => apiAdminDeleteLocation(client.id, site.id),
      'Could not delete this location.',
    );
  };

  const removeAllLocations = async (client: AdminClientDto) => {
    const ok = await confirmDestructive(
      client.id,
      () => apiAdminClientImpact(client.id),
      `every location of ${client.projectNumber}`,
      client.projectNumber,
      `All ${client.locations.length} locations go. The client itself stays, so you can add new ones.`,
    );
    if (!ok) return;
    await run(
      client.id,
      () => apiAdminDeleteAllLocations(client.id),
      'Could not delete these locations.',
    );
  };

  const removeClient = async (client: AdminClientDto) => {
    const ok = await confirmDestructive(
      client.id,
      () => apiAdminClientImpact(client.id),
      client.projectNumber,
      client.projectNumber,
      'The client, every location under it, and every delivery ever made to them.',
    );
    if (!ok) return;
    await run(client.id, () => apiAdminDeleteClient(client.id), 'Could not delete this client.');
  };

  if (loading && clients.length === 0) return <LoadingState label="Loading clients…" />;
  if (loadError && clients.length === 0) {
    return (
      <ScreenScroll>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Text style={{ opacity: 0.7 }}>
        Clients and the locations they take delivery at. Deleting anything here is permanent.
      </Text>

      {actionError ? <ErrorText>{actionError}</ErrorText> : null}

      {clients.length === 0 ? (
        <Card>
          <Text>No clients yet.</Text>
          <Text style={styles.hint}>
            A client is created with its first project, on the New Batch screen.
          </Text>
          <SecondaryButton title="Start a batch" onPress={() => router.push('/new')} />
        </Card>
      ) : null}

      {clients.map((c) => {
        const open = expanded === c.id;
        return (
          <Card key={c.id}>
            <Pressable onPress={() => setExpanded(open ? null : c.id)}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 17, fontWeight: '700', flexShrink: 1 }}>
                  {c.projectNumber}
                </Text>
                <StatusBadge
                  label={c.status === 'ACTIVE' ? 'Active' : 'Closed'}
                  tone={c.status === 'ACTIVE' ? 'neutral' : 'done'}
                />
              </View>
              <Text style={styles.hint}>
                {c.projectManagerName} · {c.locations.length} location
                {c.locations.length === 1 ? '' : 's'} · {c.batchCount} batch
                {c.batchCount === 1 ? '' : 'es'}
              </Text>
              <Text style={{ color: colors.brand, fontWeight: '600', marginTop: 6 }}>
                {open ? 'Hide locations' : 'Show locations'}
              </Text>
            </Pressable>

            {open ? (
              <View style={{ marginTop: 8, gap: 6 }}>
                {c.locations.length === 0 ? (
                  <Text style={styles.hint}>No locations on this client.</Text>
                ) : (
                  c.locations.map((site) => (
                    <View
                      key={site.id}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <View style={{ flexShrink: 1 }}>
                        <Text style={{ fontWeight: '600' }}>{site.name}</Text>
                        <Text style={styles.hint}>
                          {site.location} · {site.batchCount} batch
                          {site.batchCount === 1 ? '' : 'es'}
                        </Text>
                      </View>
                      <Pressable
                        disabled={busyId === c.id}
                        onPress={() => void removeLocation(c, site)}
                        style={{ paddingVertical: 6, paddingHorizontal: 4 }}
                      >
                        <Text style={{ color: colors.danger, fontWeight: '600' }}>Delete</Text>
                      </Pressable>
                    </View>
                  ))
                )}

                <View style={{ flexDirection: 'row', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                  {c.locations.length > 0 ? (
                    <Pressable
                      disabled={busyId === c.id}
                      onPress={() => void removeAllLocations(c)}
                    >
                      <Text style={{ color: colors.danger, fontWeight: '600' }}>
                        {busyId === c.id ? 'Working…' : 'Delete all locations'}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable disabled={busyId === c.id} onPress={() => void removeClient(c)}>
                    <Text style={{ color: colors.danger, fontWeight: '700' }}>
                      Delete this client
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </Card>
        );
      })}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
