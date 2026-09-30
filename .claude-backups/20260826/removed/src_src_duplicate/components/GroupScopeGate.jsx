import { IoArrowBack, IoAlertCircleOutline, IoArrowForward, IoPeopleOutline } from 'react-icons/io5';
import './GroupScopeGate.css';

// ─── Group scoping gate ────────────────────────────────────────────────────────
// Reusable UI for Volcán Desk config domains (Tipos, Categorías, Campos del
// Formulario, Flujos, Prioridades) that must be scoped per Grupo de soporte so
// Finanzas/BI/Proyectos/etc. don't share catalogs with each other. Voltik never
// uses this — it keeps its single shared catalog per module, as before.
//
// Usage: render <GroupScopePicker> until a group is chosen, then render the
// existing per-domain page passing selectedGroupId down so create/update
// handlers stamp { grupoId: selectedGroupId }, and list reads filter by it.

export function GroupScopePicker({ itemLabelPlural, groups, items, getGroupId, onSelectGroup, onManageUnassigned }) {
    const countFor = (groupId) => items.filter(i => getGroupId(i) === groupId).length;
    const unassigned = items.filter(i => !getGroupId(i));

    return (
        <div className="gsg-picker">
            <p className="gsg-picker-hint">
                Elige un grupo de soporte para administrar sus propios {itemLabelPlural}. Cada grupo tiene su catálogo independiente.
            </p>
            <div className="gsg-group-grid">
                {groups.map(g => (
                    <button key={g.id} className="gsg-group-card" onClick={() => onSelectGroup(g.id)}>
                        <div className="gsg-group-icon"><IoPeopleOutline size={18} /></div>
                        <div className="gsg-group-body">
                            <div className="gsg-group-name">{g.name}</div>
                            <div className="gsg-group-count">{countFor(g.id)} {itemLabelPlural}</div>
                        </div>
                        <IoArrowForward size={16} className="gsg-group-arrow" />
                    </button>
                ))}
                {groups.length === 0 && (
                    <div className="gsg-empty">
                        No hay grupos de soporte creados todavía para Volcán Desk. Crea uno primero en Usuarios → Grupos.
                    </div>
                )}
            </div>
            {unassigned.length > 0 && (
                <button className="gsg-unassigned-banner" onClick={onManageUnassigned}>
                    <IoAlertCircleOutline size={18} />
                    <span>{unassigned.length} {itemLabelPlural} sin grupo asignado — clic para revisar y reasignar</span>
                    <IoArrowForward size={16} />
                </button>
            )}
        </div>
    );
}

export function GroupScopeReassign({ itemLabelPlural, items, groups, getGroupId, getLabel, onAssign, onBack }) {
    const unassigned = items.filter(i => !getGroupId(i));
    return (
        <div className="gsg-reassign">
            <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={16} /> Volver a grupos</button>
            <p className="gsg-picker-hint" style={{ marginTop: 12 }}>
                Estos {itemLabelPlural} son datos previos a la separación por grupo. Asígnales un grupo para que dejen de mostrarse a todos.
            </p>
            <div className="gsg-reassign-list">
                {unassigned.map(item => (
                    <div key={item.id} className="gsg-reassign-row">
                        <span className="gsg-reassign-label">{getLabel(item)}</span>
                        <select defaultValue="" onChange={e => { if (e.target.value) { onAssign(item, e.target.value); e.target.value = ''; } }}>
                            <option value="" disabled>Asignar a grupo…</option>
                            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                    </div>
                ))}
                {unassigned.length === 0 && <div className="gsg-empty">Todo reasignado ✓</div>}
            </div>
        </div>
    );
}

// Small breadcrumb shown at the top of a scoped domain page once a group is selected.
export function GroupScopeBreadcrumb({ groupName, onChangeGroup }) {
    return (
        <button className="gsg-change-group-btn" onClick={onChangeGroup}>
            <IoPeopleOutline size={14} /> Grupo: <strong>{groupName}</strong> <span className="gsg-change-link">— cambiar</span>
        </button>
    );
}
