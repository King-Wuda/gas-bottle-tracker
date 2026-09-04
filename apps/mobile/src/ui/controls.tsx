import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewProps,
} from 'react-native';
import {
  maskProjectNumber,
  isValidProjectNumber,
  PROJECT_NUMBER_ERROR,
  PROJECT_NUMBER_PLACEHOLDER,
} from '@gct/shared';
import { styles as base } from './components';
import { colors, radius, space, type } from './theme';

/**
 * Form controls for the batch-creation and batch-browsing screens.
 *
 * Two platform notes that apply to everything here, because they are the difference
 * between "works in the browser" and "works on the phone" (see CLAUDE.md):
 *
 * 1. Dropdown lists expand INLINE and push content down, rather than floating in an
 *    absolutely-positioned overlay. Every screen here is a ScrollView, and on Android
 *    an absolutely-positioned child of a scrolling parent is clipped at the parent's
 *    bounds — the list would look right on web and be invisible on device.
 *
 * 2. `role` is set explicitly. On react-native-web it becomes the DOM ARIA role; on
 *    native React Native maps it to `accessibilityRole`. One prop, correct semantics
 *    on both, which is what section 5 of the spec asks for.
 */

// ---------------------------------------------------------------- project number

/**
 * The masked project-number field: the operator types digits, the dashes appear.
 *
 * Validation fires on blur and again at submit (the caller checks `isValidProjectNumber`
 * before enabling its button) — never on every keystroke, which would flag `1234` as
 * malformed while someone is still typing the first group.
 */
export function ProjectNumberField({
  value,
  onChangeText,
  editable = true,
  showErrorNow = false,
}: {
  value: string;
  onChangeText: (next: string) => void;
  editable?: boolean;
  /** Set at submit time to reveal the error even if the field was never blurred. */
  showErrorNow?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const invalid = value.length > 0 && !isValidProjectNumber(value);
  const show = invalid && (touched || showErrorNow);

  return (
    <View style={base.fieldWrap}>
      <Text style={base.label}>Project number</Text>
      <TextInput
        style={[base.input, show && controls.inputInvalid]}
        value={value}
        // The mask is the only writer of this value, so non-digits can never enter the
        // state — pasting `123456-789-1-23` re-masks to itself, and typing a letter is
        // a no-op rather than a character that has to be rejected later.
        onChangeText={(t) => onChangeText(maskProjectNumber(t))}
        onBlur={() => setTouched(true)}
        placeholder={PROJECT_NUMBER_PLACEHOLDER}
        placeholderTextColor={colors.inkFaint}
        keyboardType="number-pad"
        inputMode="numeric"
        editable={editable}
        aria-invalid={show}
      />
      {show ? <Text style={base.error}>{PROJECT_NUMBER_ERROR}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------- shared list bits

export interface Option {
  value: string;
  label: string;
  /** Second line — the manager's email, the site's location. */
  hint?: string;
}

function OptionRow({
  option,
  selected,
  highlighted,
  onPress,
}: {
  option: Option;
  selected: boolean;
  highlighted: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="option"
      aria-selected={selected}
      onPress={onPress}
      style={[
        controls.option,
        highlighted && controls.optionHighlighted,
        selected && controls.optionSelected,
      ]}
    >
      <Text style={[controls.optionLabel, selected && controls.optionLabelSelected]}>
        {option.label}
      </Text>
      {option.hint ? <Text style={controls.optionHint}>{option.hint}</Text> : null}
    </Pressable>
  );
}

/**
 * React Native's `Role` union omits 'listbox' — it is a web-only ARIA container role
 * with no native counterpart. react-native-web forwards it to the DOM unchanged, and
 * on Android it is the rows' own `role="option"` that TalkBack announces, so this
 * widens the type without widening behaviour.
 */
const LISTBOX_ROLE = 'listbox' as ViewProps['role'];

/** The expanding panel every dropdown here shares. Caps its own height and scrolls. */
function OptionList({ children }: { children: ReactNode }) {
  return (
    <View role={LISTBOX_ROLE} style={controls.list}>
      <ScrollView
        style={controls.listScroll}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {children}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------- select

/**
 * A plain dropdown. Used for the project manager, the supplier, and the filter panel.
 *
 * `disabled` is a first-class state rather than "render nothing": the supplier select
 * exists before a gas is chosen and has to say why it cannot be used yet.
 */
export function Select({
  label,
  placeholder = 'Select...',
  options,
  value,
  onChange,
  disabled = false,
  disabledHint,
  footer,
}: {
  label: string;
  placeholder?: string;
  options: Option[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  disabledHint?: string;
  /** Rendered under the control — the selected manager's email, for instance. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <View style={base.fieldWrap}>
      <Text style={base.label}>{label}</Text>
      <Pressable
        role="button"
        aria-expanded={open}
        aria-disabled={disabled}
        disabled={disabled}
        onPress={() => setOpen((o) => !o)}
        style={[base.input, controls.selectBox, disabled && controls.disabled]}
      >
        <Text style={selected ? controls.selectValue : controls.selectPlaceholder}>
          {selected?.label ?? placeholder}
        </Text>
        <Text style={controls.caret}>{open ? '▴' : '▾'}</Text>
      </Pressable>

      {disabled && disabledHint ? <Text style={controls.hint}>{disabledHint}</Text> : null}

      {open && !disabled ? (
        <OptionList>
          {options.length === 0 ? (
            <Text style={controls.emptyOption}>Nothing to choose from yet.</Text>
          ) : (
            options.map((o) => (
              <OptionRow
                key={o.value}
                option={o}
                selected={o.value === value}
                highlighted={false}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              />
            ))
          )}
        </OptionList>
      ) : null}

      {footer}
    </View>
  );
}

// ---------------------------------------------------------------- combobox

/** Sentinel for the "use what I typed" row. A leading space cannot collide with an id. */
const FREE_ENTRY = ' free';

/**
 * The site field: a filtering combobox that also accepts anything typed.
 *
 * Two behaviours worth stating because they are easy to get subtly wrong:
 *
 * - The list opens on FOCUS, showing everything, before a single character is typed.
 *   Someone who does not know what is on the list must be able to look.
 * - Free entry is offered as an explicit `Use "..."` row rather than left implicit. A
 *   typed value that matches nothing is legitimate here, and the operator should not
 *   have to guess whether pressing on will keep it.
 *
 * Arrow-key navigation is a web affordance. `onKeyPress` on a native TextInput only
 * reports character keys and backspace — there are no arrow keys on a phone keyboard —
 * so on Android the same list is driven by tapping, which is the native equivalent and
 * loses nothing.
 */
export function Combobox({
  label,
  value,
  onChangeText,
  options,
  placeholder,
  onPick,
  editable = true,
  emptyHint = 'Nothing on record yet — type a name.',
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  options: Option[];
  placeholder?: string;
  /** Fires with the chosen option, or null when the typed text is used as-is. */
  onPick?: (option: Option | null) => void;
  editable?: boolean;
  emptyHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trimmed = value.trim();
  const visible = useMemo(() => {
    const needle = trimmed.toLowerCase();
    // Substring, anywhere, case-insensitive — "depot" has to find "Killarney Depot".
    const matches = needle
      ? options.filter((o) => o.label.toLowerCase().includes(needle))
      : options;
    const exact = options.some((o) => o.label.toLowerCase() === needle);
    return trimmed && !exact
      ? [...matches, { value: FREE_ENTRY, label: `Use "${trimmed}"`, hint: 'Not on the list' }]
      : matches;
  }, [options, trimmed]);

  const choose = useCallback(
    (option: Option) => {
      if (option.value === FREE_ENTRY) {
        onPick?.(null);
      } else {
        onChangeText(option.label);
        onPick?.(option);
      }
      setOpen(false);
    },
    [onChangeText, onPick],
  );

  const onKeyPress = (e: { nativeEvent: { key: string } }): void => {
    const key = e.nativeEvent.key;
    if (key === 'Escape') {
      setOpen(false);
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!open) {
        setOpen(true);
        return;
      }
      if (visible.length === 0) return;
      setHighlight((i) => {
        const next = key === 'ArrowDown' ? i + 1 : i - 1;
        return (next + visible.length) % visible.length;
      });
      return;
    }
    if (key === 'Enter') {
      const target = visible[highlight];
      if (open && target) choose(target);
      return;
    }
    // Any other key changes the text, so the old highlight index means nothing.
    setHighlight(0);
  };

  return (
    <View style={base.fieldWrap}>
      <Text style={base.label}>{label}</Text>
      <TextInput
        style={base.input}
        value={value}
        onChangeText={(t) => {
          onChangeText(t);
          setOpen(true);
        }}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setOpen(true);
          setHighlight(0);
        }}
        // Deferred: on web, tapping an option blurs the input first, and closing
        // immediately would unmount the row before its press ever lands.
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyPress={onKeyPress}
        placeholder={placeholder}
        placeholderTextColor={colors.inkFaint}
        editable={editable}
        autoCorrect={false}
        role="combobox"
        aria-expanded={open}
      />

      {open ? (
        <OptionList>
          {visible.length === 0 ? (
            <Text style={controls.emptyOption}>{emptyHint}</Text>
          ) : (
            visible.map((o, i) => (
              <OptionRow
                key={o.value}
                option={o}
                selected={o.label === value}
                highlighted={i === highlight}
                onPress={() => choose(o)}
              />
            ))
          )}
        </OptionList>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- toggles

/**
 * Two (or more) buttons, exactly one selected — the initial delivery point.
 *
 * Styled as buttons, but a radio group underneath: `role="radiogroup"` wrapping
 * `role="radio"` children is what a screen reader needs to announce "1 of 2 selected"
 * instead of reading out two unrelated buttons.
 */
export function SegmentedToggle<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={base.fieldWrap}>
      <Text style={base.label}>{label}</Text>
      <View role="radiogroup" aria-label={label} style={controls.toggleRow}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              role="radio"
              aria-checked={selected}
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              onPress={() => onChange(o.value)}
              style={[
                controls.toggleButton,
                selected ? controls.toggleButtonOn : controls.toggleButtonOff,
                disabled && controls.disabled,
              ]}
            >
              <Text style={selected ? controls.toggleTextOn : controls.toggleTextOff}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A labelled on/off switch — the "include already-transferred batches" control. */
export function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Pressable
      role="switch"
      aria-checked={value}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={controls.switchRow}
    >
      <View style={controls.switchLabels}>
        <Text style={controls.switchLabel}>{label}</Text>
        {hint ? <Text style={controls.optionHint}>{hint}</Text> : null}
      </View>
      <View style={[controls.switchTrack, value && controls.switchTrackOn]}>
        <View style={[controls.switchKnob, value && controls.switchKnobOn]} />
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------- chips & badges

/** A removable active-filter chip. */
export function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Pressable
      role="button"
      aria-label={`Remove filter: ${label}`}
      onPress={onRemove}
      style={controls.chip}
    >
      <Text style={controls.chipText}>{label}</Text>
      <Text style={controls.chipX}>×</Text>
    </Pressable>
  );
}

export type BadgeTone = 'neutral' | 'moved' | 'done';

const BADGE_TONE: Record<BadgeTone, { backgroundColor: string }> = {
  neutral: { backgroundColor: colors.sunken },
  moved: { backgroundColor: colors.warning },
  done: { backgroundColor: colors.success },
};

/** Neutral badges keep body ink; the coloured ones are filled, so their text flips. */

/**
 * The row's status marker — so an already-transferred batch cannot be mistaken for an
 * available one when the toggle brings it back into the list.
 */
export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: BadgeTone }) {
  return (
    <View style={[controls.badge, BADGE_TONE[tone]]}>
      <Text style={[controls.badgeText, tone !== 'neutral' && controls.badgeTextStrong]}>
        {label}
      </Text>
    </View>
  );
}

const controls = StyleSheet.create({
  inputInvalid: { borderColor: colors.danger, backgroundColor: colors.dangerTint },
  hint: type.caption,
  disabled: { opacity: 0.45 },

  selectBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  selectValue: { fontSize: 16, color: colors.ink },
  selectPlaceholder: { fontSize: 16, color: colors.inkFaint },
  caret: { fontSize: 11, color: colors.inkFaint },

  list: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginTop: space.xs + 2,
    overflow: 'hidden',
  },
  listScroll: { maxHeight: 260 },
  option: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 },
  optionHighlighted: { backgroundColor: colors.brandTint },
  optionSelected: { backgroundColor: colors.brandTintStrong },
  optionLabel: { fontSize: 15, color: colors.ink },
  optionLabelSelected: { fontWeight: '700', color: colors.brand },
  optionHint: { ...type.caption, fontSize: 13 },
  emptyOption: { padding: space.lg, ...type.caption },

  toggleRow: { flexDirection: 'row', gap: space.sm },
  toggleButton: {
    flex: 1,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  toggleButtonOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  toggleButtonOff: { backgroundColor: colors.surface, borderColor: colors.border },
  toggleTextOn: { color: colors.onBrand, fontSize: 15, fontWeight: '700' },
  toggleTextOff: { color: colors.inkMuted, fontSize: 15, fontWeight: '600' },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.sm,
  },
  switchLabels: { flex: 1, gap: 2 },
  switchLabel: { fontSize: 15, fontWeight: '600', color: colors.ink },
  switchTrack: {
    width: 48,
    height: 28,
    borderRadius: radius.pill,
    padding: 3,
    backgroundColor: colors.borderStrong,
    justifyContent: 'center',
  },
  switchTrackOn: { backgroundColor: colors.brand },
  switchKnob: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    alignSelf: 'flex-start',
  },
  switchKnobOn: { alignSelf: 'flex-end' },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTint,
  },
  chipText: { fontSize: 13, fontWeight: '700', color: colors.brand },
  chipX: { fontSize: 16, color: colors.brand, lineHeight: 17 },

  badge: {
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.2 },
  badgeTextStrong: { color: colors.onBrand },
});
