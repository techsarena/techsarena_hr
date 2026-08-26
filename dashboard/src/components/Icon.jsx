/** Line icons at a single 1.6 stroke weight — sharp and engineered, not playful. */
const PATHS = {
  home: <><path d="M3 8.5 10 3l7 5.5V16a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1V8.5Z" /></>,
  clock: <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" /></>,
  calendar: <><rect x="3" y="4.5" width="14" height="12.5" rx="1.5" /><path d="M3 8h14M7 3v3M13 3v3" /></>,
  wallet: <><rect x="3" y="5" width="14" height="10" rx="2" /><path d="M14 10h2.5" /></>,
  receipt: <><path d="M5 3h10v14l-2.5-1.5L10 17l-2.5-1.5L5 17V3Z" /><path d="M8 7h4M8 10.5h4" /></>,
  target: <><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.5" /><circle cx="10" cy="10" r="0.6" fill="currentColor" /></>,
  vault: <><rect x="3" y="4" width="14" height="12" rx="1.5" /><circle cx="10" cy="10" r="3" /><path d="M10 7v-1M10 14v-1" /></>,
  bank: <><path d="M3 8 10 4l7 4M4.5 8v6M8 8v6M12 8v6M15.5 8v6M3 16.5h14" /></>,
  inbox: <><path d="M3 11.5 5 4.5h10l2 7V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5Z" /><path d="M3 11.5h4l1 2h4l1-2h4" /></>,
  // A single person, distinct from `people` (a group): "my profile" and "the
  // directory" were previously the same glyph.
  person: <><circle cx="10" cy="7" r="3" /><path d="M4.5 16.5c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" /></>,
  // A speech bubble for a conversation, so Help & requests stops sharing the
  // announcement megaphone.
  chat: <><path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h10a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 15 13H8l-3.5 3v-3H5a1.5 1.5 0 0 1-1.5-1.5v-6Z" /></>,
  // A graduation cap: training is not the same as an onboarding checklist.
  learn: <><path d="M10 4 2.5 7.5 10 11l7.5-3.5L10 4Z" /><path d="M5.5 9v4c0 1.4 2 2.5 4.5 2.5s4.5-1.1 4.5-2.5V9" /></>,
  // A document with a seal, for the policy handbook — `shield` now belongs to
  // Users & roles alone.
  policy: <><path d="M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M11.5 3v3.5H15" /><path d="M7 11.5l1.8 1.8 3.4-3.6" /></>,
  people: <><circle cx="7.5" cy="7.5" r="2.8" /><path d="M2.5 16.5c0-2.6 2.2-4.2 5-4.2s5 1.6 5 4.2" /><path d="M13.5 6.2a2.6 2.6 0 0 1 0 4.9M14.5 12.6c1.8.4 3 1.8 3 3.9" /></>,
  payroll: <><rect x="2.5" y="5" width="15" height="10" rx="1.5" /><circle cx="10" cy="10" r="2.3" /><path d="M5.5 10h.01M14.5 10h.01" /></>,
  chart: <><path d="M3 16.5h14M6 13V8M10 16V5M14 16v-6" /></>,
  ledger: <><rect x="4" y="3" width="12" height="14" rx="1.5" /><path d="M7 7h6M7 10h6M7 13h3" /></>,
  megaphone: <><path d="M4 8.5v3a1.5 1.5 0 0 0 1.5 1.5H7l6 3.5V5L7 8.5H5.5A1.5 1.5 0 0 0 4 10Z" /><path d="M15.5 8.5a2.5 2.5 0 0 1 0 3" /></>,
  briefcase: <><rect x="2.5" y="6" width="15" height="10" rx="1.5" /><path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h3A1.5 1.5 0 0 1 13 4.5V6M2.5 10.5h15" /></>,
  checklist: <><path d="M4 5.5 5.2 6.8 7.5 4.2M4 10.5l1.2 1.3 2.3-2.6M4 15.5l1.2 1.3 2.3-2.6M10.5 6h6M10.5 11h6M10.5 16h6" /></>,
  settings: <><circle cx="10" cy="10" r="2.6" /><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7" /></>,
  shield: <><path d="M10 2.8 16 5v5c0 3.4-2.4 6-6 7.2C6.4 16 4 13.4 4 10V5l6-2.2Z" /><path d="M7.5 10l1.8 1.8 3.2-3.6" /></>,
  bell: <><path d="M6 8.5a4 4 0 1 1 8 0c0 3 1.2 4 1.7 4.6.3.4 0 .9-.5.9H4.8c-.5 0-.8-.5-.5-.9C4.8 12.5 6 11.5 6 8.5Z" /><path d="M8.4 16.2a1.8 1.8 0 0 0 3.2 0" /></>,
  logout: <><path d="M12 5.5V4a1 1 0 0 0-1-1H4.5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1H11a1 1 0 0 0 1-1v-1.5" /><path d="M8.5 10h8M14 7.5 16.5 10 14 12.5" /></>,
  menu: <><path d="M3 6h14M3 10h14M3 14h14" /></>,
  download: <><path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M3.5 16h13" /></>,
  plus: <><path d="M10 4v12M4 10h12" /></>,
  check: <><path d="M4 10.5 8 14.5l8-9" /></>,
  close: <><path d="M5 5l10 10M15 5 5 15" /></>,
  chevronLeft: <><path d="M12 4.5 6.5 10l5.5 5.5" /></>,
  chevronRight: <><path d="M8 4.5 13.5 10 8 15.5" /></>,
  external: <><path d="M11 3h6v6M17 3l-7.5 7.5" /><path d="M15 12v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" /></>,
  refresh: <><path d="M16.5 8A6.5 6.5 0 0 0 5.2 5.4M3.5 12A6.5 6.5 0 0 0 14.8 14.6" /><path d="M16.5 3.5V8H12M3.5 16.5V12H8" /></>,
  search: <><circle cx="8.5" cy="8.5" r="5" /><path d="M12.2 12.2 16.5 16.5" /></>,
  filter: <><path d="M3 5h14l-5.5 6.2V16L8.5 17v-5.8L3 5Z" /></>,
};

export function Icon({ name, size = 18, className = '' }) {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}
