import React, { useState, useRef, useEffect } from 'react';

/**
 * ContactAutocomplete
 * Props: users[], value (userId), onChange(user)
 */
export default function ContactAutocomplete({ users = [], value, onChange, placeholder = 'Buscar contacto...' }) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [highlighted, setHighlighted] = useState(0);
    const containerRef = useRef(null);

    const selected = users.find(u => u.id === value);

    const filtered = query.length >= 1
        ? users.filter(u =>
            u.name.toLowerCase().includes(query.toLowerCase()) ||
            u.email?.toLowerCase().includes(query.toLowerCase())
          )
        : users.slice(0, 8);

    useEffect(() => {
        const handler = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const select = (user) => {
        onChange(user);
        setQuery('');
        setOpen(false);
    };

    const handleKeyDown = (e) => {
        if (!open) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, filtered.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
        else if (e.key === 'Enter' && filtered[highlighted]) { e.preventDefault(); select(filtered[highlighted]); }
        else if (e.key === 'Escape') setOpen(false);
    };

    const ROLE_COLORS = { admin: '#8b5cf6', agent: '#06b6d4', user: '#ec4899', client: '#ec4899' };

    return (
        <div ref={containerRef} style={{ position: 'relative' }}>
            {selected && !open ? (
                <div
                    style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 12px',
                        background: 'var(--color-bg-secondary)',
                        border: '1px solid var(--glass-border)',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                        fontSize: '0.875rem',
                    }}
                    onClick={() => { setQuery(''); setOpen(true); }}
                >
                    <div style={{
                        width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                        background: ROLE_COLORS[selected.role] || '#8b5cf6',
                        color: '#fff', fontWeight: 700, fontSize: '0.7rem',
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>
                        {selected.name.substring(0, 2).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{selected.name}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{selected.email}</div>
                    </div>
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onChange(null); }}
                        style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 16, padding: 0, width: 'auto', lineHeight: 1 }}
                    >×</button>
                </div>
            ) : (
                <input
                    type="text"
                    value={query}
                    autoFocus={open}
                    placeholder={placeholder}
                    onChange={e => { setQuery(e.target.value); setOpen(true); setHighlighted(0); }}
                    onFocus={() => setOpen(true)}
                    onKeyDown={handleKeyDown}
                    style={{ width: '100%' }}
                />
            )}

            {open && (
                <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999,
                    background: 'var(--color-bg-secondary)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-lg)',
                    maxHeight: 260,
                    overflowY: 'auto',
                    marginTop: 4,
                }}>
                    {filtered.length === 0 ? (
                        <div style={{ padding: '12px 14px', color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
                            Sin resultados
                        </div>
                    ) : filtered.map((user, idx) => (
                        <div
                            key={user.id}
                            onMouseDown={(e) => { e.preventDefault(); select(user); }}
                            onMouseEnter={() => setHighlighted(idx)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '9px 14px',
                                cursor: 'pointer',
                                background: idx === highlighted ? 'var(--color-bg-hover)' : 'transparent',
                                transition: 'background 0.1s',
                            }}
                        >
                            <div style={{
                                width: 30, height: 30, borderRadius: '50%',
                                background: ROLE_COLORS[user.role] || '#8b5cf6',
                                color: '#fff', fontWeight: 700, fontSize: '0.75rem',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                            }}>
                                {user.name.substring(0, 2).toUpperCase()}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-text-primary)' }}>{user.name}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{user.email} · {user.role}</div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
