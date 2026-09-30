import { useState, useEffect, useRef } from 'react';
import { IoPencilOutline } from 'react-icons/io5';

// ─── Click-to-edit wrapper ─────────────────────────────────────────────────
// Muestra el valor en modo lectura; al hacer clic se convierte en el
// elemento editable que le pase el padre (renderEdit).
export default function ClickToEdit({ readValue, renderEdit, disabled }) {
    const [editing, setEditing] = useState(false);
    const wrapRef = useRef(null);

    useEffect(() => {
        if (!editing) return;
        const handler = (e) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) {
                // El calendario nativo de <input type="date"> (flechas de mes,
                // días, etc.) se pinta fuera del árbol DOM de la página, así que
                // interactuar con él dispara un mousedown que este listener veía
                // como "afuera" y cerraba el campo antes de terminar de elegir
                // fecha — reportado en vivo 2026-09-17 ("le doy para abajo en la
                // flecha y se cierra el calendario"). Mientras el navegador siga
                // enfocando el propio <input> (que es justo lo que pasa durante
                // toda esa interacción con su popup nativo), no se cierra.
                if (wrapRef.current.contains(document.activeElement)) return;
                setEditing(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [editing]);

    if (disabled) {
        return <div className="cte-readonly">{readValue || '—'}</div>;
    }

    return (
        <div ref={wrapRef} className={`cte-wrap ${editing ? 'cte-active' : ''}`}>
            {editing
                ? renderEdit(() => setEditing(false))
                : (
                    <div className="cte-readonly cte-clickable" onClick={() => setEditing(true)}>
                        {readValue || <span className="cte-empty">Clic para editar</span>}
                        <IoPencilOutline size={11} className="cte-icon" />
                    </div>
                )
            }
        </div>
    );
}
