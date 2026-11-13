import type { Key, ReactNode } from "react";
import { Tab, TabList, TabPanel, Tabs as AriaTabs } from "react-aria-components";

/**
 * Tabs over a list, one panel for the selected one: arrow keys move between tabs, Home and End
 * jump, and the panel follows. Only the selected tab's panel is drawn, so a hidden terminal never
 * streams.
 */
export function Tabs({
  label,
  items,
  selected,
  onSelect,
  children,
}: {
  label: string;
  /** Each tab, and what it shows. */
  items: readonly { readonly id: string; readonly label: ReactNode }[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <AriaTabs
      className="tabs"
      selectedKey={selected}
      onSelectionChange={(key: Key) => onSelect(String(key))}
    >
      <TabList aria-label={label} className="tab-list">
        {items.map((item) => (
          <Tab key={item.id} id={item.id} className="tab">
            {item.label}
          </Tab>
        ))}
      </TabList>
      <TabPanel id={selected} className="tab-panel">
        {children}
      </TabPanel>
    </AriaTabs>
  );
}
