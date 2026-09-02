import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { isValidProjectNumber, type ProjectManagerDto, type SiteOption } from '@gct/shared';
import {
  ApiError,
  apiCreateProject,
  apiProjectManagers,
  apiSiteOptions,
} from '../../src/api/client';
import { useNewFlow } from '../../src/new/NewFlowContext';
import { ErrorText, Field, PrimaryButton, ScreenScroll, styles } from '../../src/ui/components';
import { Combobox, ProjectNumberField, Select } from '../../src/ui/controls';

export default function CreateSite() {
  const router = useRouter();
  const { setTarget } = useNewFlow();

  const [projectNumber, setProjectNumber] = useState('');
  const [managers, setManagers] = useState<ProjectManagerDto[]>([]);
  const [projectManagerId, setProjectManagerId] = useState<string | null>(null);
  const [siteOptions, setSiteOptions] = useState<SiteOption[]>([]);
  const [siteName, setSiteName] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.allSettled([apiProjectManagers(), apiSiteOptions()]).then(([pm, sites]) => {
      if (pm.status === 'fulfilled') setManagers(pm.value.projectManagers);
      else setError('Could not load the project managers. Check your connection.');
      // The site list is a convenience — free entry works without it, so a failure
      // here is not worth blocking the form for.
      if (sites.status === 'fulfilled') setSiteOptions(sites.value.sites);
    });
  }, []);

  const selectedManager = managers.find((m) => m.id === projectManagerId) ?? null;

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
      const { project } = await apiCreateProject({
        projectNumber,
        projectManagerId,
        site: { name: siteName.trim(), location: location.trim() },
      });
      setTarget({
        projectId: project.id,
        siteId: project.sites[0]!.id,
        projectNumber: project.projectNumber,
        siteName: project.sites[0]!.name,
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
              <Text style={styles.label}>Emails go to {selectedManager.email}</Text>
            ) : null
          }
        />

        <Combobox
          label="Site"
          value={siteName}
          onChangeText={setSiteName}
          placeholder="Start typing, or pick from the list"
          options={siteOptions.map((s) => ({ value: s.name, label: s.name, hint: s.location }))}
          // Picking a known site prefills the location it was last recorded with;
          // typing a new one leaves it for the operator, since nothing is known yet.
          onPick={(option) => {
            if (!option) return;
            const match = siteOptions.find((s) => s.name === option.label);
            if (match && !location.trim()) setLocation(match.location);
          }}
          editable={!busy}
          emptyHint="No sites on record yet — type the name of this one."
        />

        <Field label="Location" value={location} onChangeText={setLocation} editable={!busy} />

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
