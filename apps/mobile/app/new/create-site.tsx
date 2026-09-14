import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { isValidProjectNumber, type ClientOption, type ProjectManagerDto } from '@gct/shared';
import {
  ApiError,
  apiClientOptions,
  apiCreateProject,
  apiProjectManagers,
} from '../../src/api/client';
import { useNewFlow } from '../../src/new/NewFlowContext';
import { ErrorText, PrimaryButton, ScreenScroll, styles } from '../../src/ui/components';
import { Combobox, ProjectNumberField, Select } from '../../src/ui/controls';

export default function CreateSite() {
  const router = useRouter();
  const { setTarget } = useNewFlow();

  const [projectNumber, setProjectNumber] = useState('');
  const [managers, setManagers] = useState<ProjectManagerDto[]>([]);
  const [projectManagerId, setProjectManagerId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<ClientOption[]>([]);
  const [siteName, setSiteName] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.allSettled([apiProjectManagers(), apiClientOptions()]).then(([pm, dir]) => {
      if (pm.status === 'fulfilled') setManagers(pm.value.projectManagers);
      else setError('Could not load the project managers. Check your connection.');
      // The directory is a convenience — free entry still works without it, and a
      // technician in a yard must not be blocked by a client nobody has registered.
      if (dir.status === 'fulfilled') setDirectory(dir.value.clients);
    });
  }, []);

  const selectedManager = managers.find((m) => m.id === projectManagerId) ?? null;

  /** The directory entry the Site box currently names, if it names a known one. */
  const pickedClient =
    directory.find((c) => c.name.trim().toLowerCase() === siteName.trim().toLowerCase()) ?? null;

  const ready =
    isValidProjectNumber(projectNumber) &&
    !!projectManagerId &&
    siteName.trim().length > 0 &&
    location.trim().length > 0;

  const submit = async () => {
    setSubmitted(true);
    // Validated again here, not only by the disabled button: `ready` gates the tap,
    // and the server's zod schema and the DB CHECK gate the write. Three layers, the
    // outer two for the operator and the inner one because the API is reachable
    // without this app at all.
    if (!ready || !projectManagerId) return;

    setBusy(true);
    setError(null);
    try {
      // Sent as text, not ids: picking McCains from the directory and typing it
      // because it is new both have to work. The server matches an existing client
      // case-insensitively and creates one only when there is no match, so the
      // directory grows by being used without ever growing a second McCains.
      const { project, siteId } = await apiCreateProject({
        projectNumber,
        projectManagerId,
        clientName: siteName.trim(),
        location: location.trim(),
      });
      setTarget({
        projectId: project.id,
        siteId,
        projectNumber: project.projectNumber,
        siteName: project.clientName,
      });
      router.push('/new/line-items');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError('That project number is already in use.');
      } else if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScreenScroll>
        <ProjectNumberField
          value={projectNumber}
          onChangeText={setProjectNumber}
          editable={!busy}
          showErrorNow={submitted}
        />

        <Select
          label="Project manager"
          placeholder={managers.length === 0 ? 'Loading managers...' : 'Choose a project manager'}
          options={managers.map((m) => ({ value: m.id, label: m.name, hint: m.email }))}
          value={projectManagerId}
          onChange={setProjectManagerId}
          disabled={busy}
          // Read-only, under the dropdown: the operator has to be able to see which
          // address the batch mail will actually go to before committing to it.
          footer={
            selectedManager ? (
              <Text style={styles.hint}>Emails go to {selectedManager.email}</Text>
            ) : null
          }
        />

        {/* The two boxes are the client and their place. Both read the directory, and
            the second is scoped to whichever client the first names — so picking
            McCains offers Durban, Cape Town and Midrand and nothing else. */}
        <Combobox
          label="Site"
          value={siteName}
          onChangeText={setSiteName}
          placeholder="Start typing, or pick from the list"
          options={directory.map((c) => ({
            value: c.name,
            label: c.name,
            hint:
              c.sites.length === 0
                ? 'No locations yet'
                : c.sites.map((site) => site.location).join(', '),
          }))}
          // Picking a client with exactly one place fills it in: there is nothing to
          // choose, and making them type it invites a spelling the directory will not
          // match. More than one, and the choice is theirs.
          onPick={(option) => {
            if (!option) return;
            const match = directory.find((c) => c.name === option.label);
            if (match?.sites.length === 1 && !location.trim()) {
              setLocation(match.sites[0]!.location);
            }
          }}
          editable={!busy}
          emptyHint="No clients on record yet — type this one's name."
        />

        <Combobox
          label="Location"
          value={location}
          onChangeText={setLocation}
          placeholder={
            pickedClient ? 'Start typing, or pick from the list' : 'Name the client first'
          }
          options={(pickedClient?.sites ?? []).map((site) => ({
            value: site.location,
            label: site.location,
          }))}
          editable={!busy}
          emptyHint={
            pickedClient
              ? `${pickedClient.name} has no locations yet — type this one.`
              : 'A new client. Type where they take delivery.'
          }
        />

        <ErrorText>{error}</ErrorText>
        <PrimaryButton
          title="Continue"
          onPress={() => void submit()}
          disabled={!ready}
          busy={busy}
        />
      </ScreenScroll>
    </KeyboardAvoidingView>
  );
}
