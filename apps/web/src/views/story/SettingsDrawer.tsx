// Story settings drawer shell (right slide-in with collapsible sections).

import { useEffect, useState } from "react";
import { type CompressedRange } from "../../api/ranges";
import { type Provider } from "../../api/providers";
import { type Story } from "../../api/stories";
import { ghostClass } from "../../ui";
import { AdvancedPanel, NarrativeSection, ProviderSelect, StorySection } from "./DrawerPanels";
import { RangesPanel } from "./RangesPanel";
import { ScriptsPanel } from "./ScriptsPanel";

function DrawerSection({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border py-1" data-drawer-section={id}>
      <button
        className="flex w-full items-center justify-between py-2 text-left text-sm font-medium"
        onClick={onToggle}
        aria-expanded={open}
      >
        {title}
        <span className="text-text-muted">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="pb-3">{children}</div>}
    </section>
  );
}

export function SettingsDrawer({
  story,
  actionCount,
  providers,
  ranges,
  restoreIds,
  onRestore,
  onDeleteRange,
  onClose,
  initialSection,
}: {
  story: Story;
  actionCount: number;
  providers: Provider[] | null;
  ranges: CompressedRange[] | null;
  restoreIds: string[];
  onRestore: (id: string) => void;
  onDeleteRange: (id: string) => void;
  onClose: () => void;
  initialSection: string | null;
}) {
  const [openSection, setOpenSection] = useState<string | null>(initialSection ?? "narrative");

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function toggle(section: string) {
    setOpenSection((prev) => (prev === section ? null : section));
  }

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Story settings">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} role="presentation" />
      <aside className="absolute inset-y-0 right-0 flex w-full flex-col bg-surface sm:max-w-[420px]">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="font-medium">Story settings</h2>
          <button className={ghostClass} onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <DrawerSection
            id="narrative"
            title="Narrative"
            open={openSection === "narrative"}
            onToggle={() => toggle("narrative")}
          >
            <NarrativeSection story={story} />
          </DrawerSection>
          <DrawerSection
            id="provider"
            title="Provider"
            open={openSection === "provider"}
            onToggle={() => toggle("provider")}
          >
            <ProviderSelect story={story} providers={providers} />
          </DrawerSection>
          <DrawerSection
            id="advanced"
            title="Advanced"
            open={openSection === "advanced"}
            onToggle={() => toggle("advanced")}
          >
            <AdvancedPanel story={story} />
          </DrawerSection>
          <DrawerSection
            id="scripts"
            title="Scripts"
            open={openSection === "scripts"}
            onToggle={() => toggle("scripts")}
          >
            <ScriptsPanel owner={{ kind: "story", id: story.id }} />
            {story.scenarioId && (
              <ScriptsPanel owner={{ kind: "scenario", id: story.scenarioId }} />
            )}
          </DrawerSection>
          <DrawerSection
            id="ranges"
            title="Context ranges"
            open={openSection === "ranges"}
            onToggle={() => toggle("ranges")}
          >
            <RangesPanel
              ranges={ranges}
              restoreIds={restoreIds}
              onRestore={onRestore}
              onDelete={onDeleteRange}
            />
          </DrawerSection>
          <DrawerSection
            id="story"
            title="Story"
            open={openSection === "story"}
            onToggle={() => toggle("story")}
          >
            <StorySection story={story} actionCount={actionCount} />
          </DrawerSection>
        </div>
      </aside>
    </div>
  );
}
