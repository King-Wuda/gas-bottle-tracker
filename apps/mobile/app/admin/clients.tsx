import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
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
  apiAdminCreateClient,
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
  Field,
  LoadingState,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';
import { StatusBadge } from '../../src/ui/controls';
import { colors } from '../../src/ui/theme';

/**
 * The client directory — who the depot delivers to, and where.
 *
 * This is the list the batch form reads. Its shape is the point: clients are the
 * headings and their places sit underneath, so "which sites does McCains have?" is
 * answered by looking rather than by remembering.
 *
 * It replaced a screen that listed PROJECTS and called them clients. That was an
 * honest reflection of the old schema, where a Site belonged to the job that typed
 * it — the same customer's Durban existed once per project and nothing could group
 * them. Sites now hang off the client, and this screen is what maintains them.
 *
 * Deleting a whole client is still destructive, because their projects and every
 * delivery ever made to them go too. Deleting one PROJECT lives on its own screen:
 * reference data and evidence should not share a row of buttons.
 */
export default function AdminClients() {
  const [clients, setClients] = useState<AdminClientDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiAdminClients();
      setClients(res.clients);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load the directory.');
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
   * Add a client location.
   *
   * The whole reason this is not a plain POST: a name already in the directory is the
   * COMMON case, not an error. McCains gets a Durban today and a Cape Town next month,
   * typed by different people who have no idea the client already exists. So the
   * server answers 409 with the existing client and its places, and we ask — which is
   * what turns a second McCains into a second site under the first one.
   */
  const save = async () => {
    const clientName = name.trim();
    const place = location.trim();
    if (!clientName || !place) return;

    setSaving(true);
    setActionError(null);
    try {
      await apiAdminCreateClient({ name: clientName, location: place });
      setName('');
      setLocation('');
      setFormOpen(false);
      await load();
      return;
    } catch (e) {
      const details =
        e instanceof ApiError && e.status === 409
          ? (e.details as { name?: string; locations?: string[] } | undefined)
          : undefined;
      if (!details) {
        setActionError(e instanceof ApiError ? e.message : 'Could not save this client.');
        return;
      }

      const existingPlaces = details.locations?.length
        ? `They already have ${details.locations.join(', ')}.`
        : 'They have no locations yet.';
      const ok = await confirmAction(
        `${details.name} is already in the directory. ${existingPlaces}\n\n` +
          `Add ${place} to the existing ${details.name}?`,
        'Client already exists',
      );
      if (!ok) return;

      try {
        await apiAdminCreateClient({ name: clientName, location: place, attachToExisting: true });
        setName('');
        setLocation('');
        setFormOpen(false);
        await load();
      } catch (again) {
        setActionError(again instanceof ApiError ? again.message : 'Could not add this location.');
      }
    } finally {
      setSaving(false);
    }
  };

  /** Add another place to a client already on the list. */
  const addLocationTo = async (client: AdminClientDto) => {
    setName(client.name);
    setLocation('');
    setFormOpen(true);
  };

  /**
   * Ask the server what a delete costs, then put the number in front of the admin.
   *
   * Always a round trip rather than a guess from the counts on screen: those count
   * batches, and the sentence that actually stops someone has the cylinders and the
   * signed delivery notes in it.
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
      return confirmAction(`Delete ${what}? Nothing has been delivered against it yet.`);
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
      `${site.location} (${client.name})`,
      site.location,
      'Cylinders from other batches parked there go back to Stores.',
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
      `every location of ${client.name}`,
      client.name,
      `All ${client.locations.length} locations go. ${client.name} stays, so you can add new ones.`,
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
      client.name,
      client.name,
      'The client, every location, and every project and delivery ever made for them.',
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
      {/* The button sits at the top, above the list, because adding is what brings
          most people to this screen — the list below is the reference. */}
      {formOpen ? (
        <Card>
          <Text style={{ fontSize: 17, fontWeight: '700' }}>Add new client location</Text>
          <Field
            label="Client"
            value={name}
            onChangeText={setName}
            placeholder="McCains"
            autoCapitalize="words"
          />
          <Field
            label="Site location"
            value={location}
            onChangeText={setLocation}
            placeholder="Durban"
            autoCapitalize="words"
          />
          <Text style={styles.hint}>
            One client can have many locations. Type a client that already exists and we will offer
            to add this location to them.
          </Text>
          <PrimaryButton
            title="Save"
            onPress={() => void save()}
            disabled={!name.trim() || !location.trim() || saving}
          />
          <SecondaryButton
            title="Cancel"
            onPress={() => {
              setFormOpen(false);
              setName('');
              setLocation('');
            }}
          />
        </Card>
      ) : (
        <PrimaryButton title="Add new client location" onPress={() => setFormOpen(true)} />
      )}

      {actionError ? <ErrorText>{actionError}</ErrorText> : null}

      <Text style={{ opacity: 0.7 }}>
        {clients.length === 0
          ? 'No clients yet. Add the first one above — the batch form picks from this list.'
          : 'The batch form picks from this list.'}
      </Text>

      {clients.map((c) => (
        <Card key={c.id}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text style={{ fontSize: 18, fontWeight: '700', flexShrink: 1 }}>{c.name}</Text>
            {c.active ? null : <StatusBadge label="Hidden" tone="done" />}
          </View>
          <Text style={styles.hint}>
            {c.projectCount} project{c.projectCount === 1 ? '' : 's'} · {c.batchCount} batch
            {c.batchCount === 1 ? '' : 'es'}
          </Text>

          {/* The client's places, listed underneath it as a subheading would be. */}
          <View style={{ marginTop: 8, gap: 4 }}>
            {c.locations.length === 0 ? (
              <Text style={styles.hint}>No locations yet.</Text>
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
                    <Text style={{ fontWeight: '600' }}>{site.location}</Text>
                    <Text style={styles.hint}>
                      {site.batchCount} batch{site.batchCount === 1 ? '' : 'es'}
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
          </View>

          <View style={{ flexDirection: 'row', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
            <Pressable disabled={busyId === c.id} onPress={() => void addLocationTo(c)}>
              <Text style={{ color: colors.brand, fontWeight: '600' }}>Add a location</Text>
            </Pressable>
            {c.locations.length > 0 ? (
              <Pressable disabled={busyId === c.id} onPress={() => void removeAllLocations(c)}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>
                  {busyId === c.id ? 'Working…' : 'Delete all locations'}
                </Text>
              </Pressable>
            ) : null}
            <Pressable disabled={busyId === c.id} onPress={() => void removeClient(c)}>
              <Text style={{ color: colors.danger, fontWeight: '700' }}>Delete client</Text>
            </Pressable>
          </View>
        </Card>
      ))}

      <SecondaryButton title="Refresh" onPress={() => void load()} />
    </ScreenScroll>
  );
}
