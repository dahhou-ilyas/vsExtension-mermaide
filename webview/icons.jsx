import React from 'react';

const Icon = ({ children, title }) => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
        {title ? <title>{title}</title> : null}
        {children}
    </svg>
);

export const ZoomInIcon = () => <Icon><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14M5 7h4M7 5v4" /></Icon>;
export const ZoomOutIcon = () => <Icon><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14M5 7h4" /></Icon>;
export const FitIcon = () => <Icon><path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" /></Icon>;
export const CopyIcon = () => <Icon><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></Icon>;
export const MarkdownIcon = () => <Icon><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" /><path d="M4 10.5v-5l2 2.5 2-2.5v5M11 5.5v5M9.5 9l1.5 1.5L12.5 9" /></Icon>;
export const DownloadIcon = () => <Icon><path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11" /></Icon>;
export const TrashIcon = () => <Icon><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" /></Icon>;
export const RefreshIcon = () => <Icon><path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2v3h-3" /></Icon>;
export const CodeIcon = () => <Icon><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" /></Icon>;
export const SearchIcon = () => <Icon><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></Icon>;
export const FlowIcon = () => (
    <Icon><rect x="5" y="1.5" width="6" height="3.5" rx="1" /><path d="M8 5v2.5M8 7.5 4 9.5M8 7.5l4 2" /><rect x="1.5" y="10" width="5" height="3.5" rx="1" /><rect x="9.5" y="10" width="5" height="3.5" rx="1" /></Icon>
);
export const InfoIcon = () => <Icon><circle cx="8" cy="8" r="6.5" /><path d="M8 7.2V11.5M8 4.8v.2" /></Icon>;
