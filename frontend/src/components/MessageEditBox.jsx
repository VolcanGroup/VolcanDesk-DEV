import { useRef, useEffect } from 'react';

// Caja de edición inline para un mensaje/nota ya enviado (2026-09-23, dentro
// de la ventana de 60s) — deliberadamente un contentEditable simple, no el
// RichTextEditor completo (con su toolbar/adjuntos/menciones): es para
// corregir algo que ya se mandó, no para redactar de nuevo desde cero.
//
// quoteHtml (opcional): si el mensaje original citaba otro ("Responder a
// este mensaje"), esa cita se pinta aquí como bloque FIJO, no editable —
// antes vivía DENTRO del mismo contentEditable que el cuerpo, así que borrar
// todo el texto dejaba editar "encima" de la cita (bug reportado en vivo
// 2026-09-24). El padre (TicketDetailView.jsx) ya la separó del texto
// editable antes de pasarla aquí.
export default function MessageEditBox({ text, quoteHtml, onChange, onSave, onCancel, saving }) {
    const ref = useRef(null);

    useEffect(() => {
        if (ref.current) ref.current.innerHTML = text;
        ref.current?.focus();
        // Solo al montar — si esto se sincronizara con `text` en cada cambio,
        // cada tecleo movería el cursor al final del contenido.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="msg-edit-box">
            {quoteHtml && (
                <div
                    className="msg-edit-quote"
                    contentEditable={false}
                    dangerouslySetInnerHTML={{ __html: quoteHtml }}
                />
            )}
            <div
                ref={ref}
                className="msg-edit-input"
                contentEditable
                suppressContentEditableWarning
                onInput={(e) => onChange(e.currentTarget.innerHTML)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') onCancel(e);
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave(e);
                }}
            />
            <div className="msg-edit-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={saving}>Cancelar</button>
                <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={saving || !text.trim()}>
                    {saving ? 'Guardando…' : 'Guardar'}
                </button>
            </div>
        </div>
    );
}
