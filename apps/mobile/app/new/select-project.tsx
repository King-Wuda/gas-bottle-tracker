import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ProjectSummary, SiteDto, SiteOption } from '@gct/shared';
import {
  ApiError,
  apiCreateSite,
  apiGetProject,
  apiSearchProjects,
  apiSiteOptions,
} from '../../src/api/client';
import { useNewFlow } from '../../src/new/NewFlowContext';
import {
  Card,
  ErrorText,
  Field,
  PrimaryButton,
  ScreenScroll,
  SecondaryButton,
  styles,
} from '../../src/ui/components';
import { Combobox } from '../../src/ui/controls';
import { colors } from '../../src/ui/theme';

export default function SelectProject() {
  const router = useRouter();
  const { setTarget } = useNewFlow();

  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [picked, setPicked] = useState<{ id: string; projectNumber: string } | null>(null);
  const [sites, setSites] = useState<SiteDto[]>([]);
  const [loadingSites, setLoadingSites] = useState(false);

  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteLoc, setNewSiteLoc] = useState('');
  const [addingSite, setAddingSite] = useState(false);
  const [siteOptions, setSiteOptions] = useState<SiteOption[]>([]);

  useEffect(() => {
    // The combobox's list. A failure here degrades to plain free entry, which is a
    // supported way to use the field anyway — so it is not worth an error state.
    apiSiteOptions()
      .then((r) => setSiteOptions(r.sites))
      .catch(() => setSiteOptions([]));
  }, []);

  const runSearch = async () => {
    setSearching(true);
    setError(null);
    setPicked(null);
    try {
      const res = await apiSearchProjects(q.trim());
      setResults(res.projects);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Search failed.');
    } finally {
      setSearching(false);
    }
  };

  const pickProject = async (p: ProjectSummary) => {
    setPicked({ id: p.id, projectNumber: p.projectNumber });
    setLoadingSites(true);
    setError(null);
    try {
      const { project } = await apiGetProject(p.id);
      setSites(project.sites);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load sites.');
    } finally {
      setLoadingSites(false);
    }
  };

  const chooseSite = (site: SiteDto) => {
    if (!picked) return;
    setTarget({
      projectId: picked.id,
      siteId: site.id,
      projectNumber: picked.projectNumber,
      siteName: site.name,
    });
    router.push('/new/line-items');
  };

  const addSite = async () => {
    if (!picked || !newSiteName.trim() || !newSiteLoc.trim()) return;
    setAddingSite(true);
    setError(null);
    try {
      const { site } = await apiCreateSite(picked.id, {
        name: newSiteName.trim(),
        location: newSiteLoc.trim(),
      });
      setSites((prev) => [...prev, site]);
      setNewSiteName('');
      setNewSiteLoc('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the site.');
    } finally {
      setAddingSite(false);
    }
  };

  return (
    <ScreenScroll>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <Field
            label="Project number or PM name"
            value={q}
            onChangeText={setQ}
            onSubmitEditing={runSearch}
            returnKeyType="search"
          />
        </View>
        <PrimaryButton title="Search" onPress={runSearch} busy={searching} disabled={!q.trim()} />
      </View>

      <ErrorText>{error}</ErrorText>

      {!picked &&
        results.map((p) => (
          <Card key={p.id} onPress={() => pickProject(p)}>
            <Text style={{ fontSize: 16, fontWeight: '700' }}>{p.projectNumber}</Text>
            <Text style={{ opacity: 0.7 }}>
              PM {p.projectManager.name} · {p.siteCount} site(s) · {p.activeBatchCount} active
              batch(es)
            </Text>
          </Card>
        ))}
      {!picked && !searching && results.length === 0 && q.trim() ? (
        <Text style={{ opacity: 0.6 }}>No matching projects. Try a different search.</Text>
      ) : null}

      {picked ? (
        <>
          <Text style={{ fontSize: 16, fontWeight: '700', marginTop: 8 }}>
            {picked.projectNumber} — choose a site
          </Text>
          {loadingSites ? <ActivityIndicator /> : null}
          {sites.map((s) => (
            <Card key={s.id} onPress={() => chooseSite(s)}>
              <Text style={{ fontSize: 15, fontWeight: '600' }}>{s.name}</Text>
              <Text style={{ opacity: 0.7 }}>{s.location}</Text>
            </Card>
          ))}

          <Text style={[styles.hint, { marginTop: 10 }]}>Add a new site to this project</Text>
          <Combobox
            label="Site"
            value={newSiteName}
            onChangeText={setNewSiteName}
            placeholder="Start typing, or pick from the list"
            options={siteOptions.map((so) => ({
              value: so.name,
              label: so.name,
              hint: so.location,
            }))}
            onPick={(option) => {
              if (!option) return;
              const match = siteOptions.find((so) => so.name === option.label);
              if (match && !newSiteLoc.trim()) setNewSiteLoc(match.location);
            }}
            editable={!addingSite}
            emptyHint="No sites on record yet — type the name of this one."
          />
          <Field label="Location" value={newSiteLoc} onChangeText={setNewSiteLoc} />
          <SecondaryButton
            title={addingSite ? 'Adding…' : 'Add site'}
            onPress={addSite}
            disabled={addingSite || !newSiteName.trim() || !newSiteLoc.trim()}
          />

          <Pressable onPress={() => setPicked(null)} style={{ paddingVertical: 12 }}>
            <Text style={{ color: colors.brand, fontWeight: '600' }}>← Back to results</Text>
          </Pressable>
        </>
      ) : null}
    </ScreenScroll>
  );
}
