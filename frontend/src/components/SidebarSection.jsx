import { IoChevronDown, IoChevronUp } from 'react-icons/io5';

// ─── Sección colapsable del panel lateral ─────────────────────────────────
export default function SidebarSection({ title, children, isOpen, onToggle }) {
    return (
        <div className={`sidebar-section ${isOpen ? 'is-open' : 'is-closed'}`}>
            <button className="sidebar-section-header" onClick={onToggle}>
                <span className="sidebar-section-title">{title}</span>
                {isOpen ? <IoChevronUp size={13} /> : <IoChevronDown size={13} />}
            </button>
            {isOpen && <div className="sidebar-section-body">{children}</div>}
        </div>
    );
}
