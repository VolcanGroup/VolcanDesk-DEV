import React, { useRef, useState, useCallback } from 'react';
import './RichTextEditor.css';
import { MdFormatBold, MdFormatItalic, MdFormatListBulleted, MdFormatListNumbered, MdCode, MdInsertLink, MdTitle } from 'react-icons/md';
import { IoAtOutline, IoClose, IoImage, IoAttachOutline, IoTextOutline, IoHappyOutline, IoFlashOutline } from 'react-icons/io5';

// Catálogo mínimo de respuestas rápidas (2026-09-24, rediseño del compositor
// estilo WhatsApp) — no existe todavía un catálogo administrable de
// plantillas en el backend, así que este es un set fijo de arranque para que
// el botón de rayo no quede vacío. Si más adelante se pide poder editarlas,
// eso es una función aparte (CRUD + almacenamiento), no solo un ajuste de UI.
const QUICK_REPLIES = [
    'Estamos revisando tu solicitud, te confirmamos en breve.',
    '¿Podrías compartir más detalle sobre esto?',
    'Quedamos atentos a tu confirmación.',
    'Ticket resuelto — cualquier duda quedamos atentos.',
];

// Set corto y de uso frecuente en soporte — no se busca cubrir todos los
// emojis existentes, solo evitar salir de la app para algo tan simple.
const EMOJI_SET = ['👍', '🙏', '✅', '❌', '⏳', '📌', '😀', '🎉', '⚠️', '🔧'];

/**
 * RichTextEditor
 * Props:
 *   - onChange (fn)              : called with {html, text, mentionedUserIds, attachments}
 *   - placeholder (string)
 *   - noteMode (bool)            : amber styling
 *   - mentionableUsers (array)   : [{id, name, role}]
 *   - attachments (array)        : [{id, name, dataUrl, type}]
 *   - onAttachmentsChange (fn)   : called with updated attachments array
 *   - compact (bool)             : barra tipo WhatsApp — toolbar de formato
 *                                   colapsada detrás de "Aa", fila de accesos
 *                                   rápidos (adjuntar/@/emoji/plantillas) y
 *                                   editor de 1 línea que crece con el texto.
 *   - onSubmit (fn)              : compact only — Enter (sin Shift) envía.
 *   - expanded (bool)            : compact only — sube el techo del editor
 *                                   (de 140px a ~360px) para redactar textos
 *                                   largos con comodidad; el control que lo
 *                                   alterna vive en el padre (TicketDetailView),
 *                                   este componente solo aplica la clase CSS —
 *                                   nunca se desmonta el contentEditable, así
 *                                   que el texto ya escrito no se pierde al
 *                                   expandir/contraer.
 */
export default function RichTextEditor({
    onChange,
    placeholder = 'Escribe aquí...',
    noteMode = false,
    mentionableUsers = [],
    attachments = [],
    onAttachmentsChange,
    compact = false,
    onSubmit,
    expanded = false
}) {
    const editorRef = useRef(null);
    const [showMentionDropdown, setShowMentionDropdown] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionAnchor, setMentionAnchor] = useState({ top: 0, left: 0 });
    const [selectedMention, setSelectedMention] = useState(0);
    const mentionedUserIds = useRef(new Set());
    // Solo aplica en modo compacto — fuera de ahí la barra de formato sigue
    // siempre visible, como antes.
    const [showFormatting, setShowFormatting] = useState(false);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showQuickReplies, setShowQuickReplies] = useState(false);

    const filteredUsers = mentionableUsers.filter(u =>
        u.name.toLowerCase().includes(mentionQuery.toLowerCase())
    );

    // ─── Toolbar commands ────────────────────────────────────────────────
    const exec = (cmd, value = null) => {
        editorRef.current?.focus();
        document.execCommand(cmd, false, value);
        notifyChange();
    };

    const notifyChange = useCallback(() => {
        if (!editorRef.current) return;
        onChange?.({
            html: editorRef.current.innerHTML,
            text: editorRef.current.innerText,
            mentionedUserIds: [...mentionedUserIds.current],
            attachments
        });
    }, [onChange, attachments]);

    // ─── Paste handler: intercept clipboard images ────────────────────────
    // Antes, además de agregar la captura como adjunto real, también la
    // insertaba INLINE en el HTML del comentario (<img src="data:...">) — eso
    // duplicaba la imagen embebida en base64 DENTRO del texto del comentario,
    // que se guarda tal cual en Comment.text. Un solo comentario con una
    // captura pegada llegó a pesar más de 500KB en vivo (2026-09-17), inflando
    // permanentemente ese ticket cada vez que alguien lo abre. Ya no se inserta
    // nada en el editor — la captura queda solo como adjunto (mismo mecanismo
    // que "Adjuntar archivo": miniatura + clic para verla completa), sin
    // duplicar los bytes en el texto. El usuario sigue pudiendo pegar con
    // Ctrl+V exactamente igual, solo cambia dónde termina la imagen.
    const handlePaste = useCallback((e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const dataUrl = ev.target.result;
                    const id = `img_${Date.now()}`;
                    const newAttachments = [
                        ...attachments,
                        { id, name: `captura_${new Date().toISOString().slice(0,19).replace('T','_')}.png`, dataUrl, type: 'image' }
                    ];
                    onAttachmentsChange?.(newAttachments);
                    notifyChange();
                };
                reader.readAsDataURL(file);
                return;
            }
        }
    }, [attachments, onAttachmentsChange, notifyChange]);

    // ─── @mention detection on input ─────────────────────────────────────
    const handleInput = useCallback(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) { notifyChange(); return; }

        const range = sel.getRangeAt(0);
        const textBefore = range.startContainer.textContent?.slice(0, range.startOffset) || '';
        const atIdx = textBefore.lastIndexOf('@');

        if (atIdx !== -1 && !textBefore.slice(atIdx + 1).includes(' ')) {
            const query = textBefore.slice(atIdx + 1);
            setMentionQuery(query);
            setSelectedMention(0);

            const rect = range.getBoundingClientRect();
            const editorRect = editorRef.current?.getBoundingClientRect();
            if (editorRect) {
                setMentionAnchor({
                    top: rect.bottom - editorRect.top + 4,
                    left: Math.max(0, rect.left - editorRect.left)
                });
            }
            setShowMentionDropdown(true);
        } else {
            setShowMentionDropdown(false);
        }
        notifyChange();
    }, [notifyChange]);

    // ─── Pick mention ─────────────────────────────────────────────────────
    const insertMention = useCallback((user) => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;

        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        const textBefore = node.textContent?.slice(0, range.startOffset) || '';
        const atIdx = textBefore.lastIndexOf('@');

        const deleteRange = document.createRange();
        deleteRange.setStart(node, atIdx);
        deleteRange.setEnd(node, range.startOffset);
        deleteRange.deleteContents();

        const chip = document.createElement('span');
        chip.className = 'mention-chip';
        chip.contentEditable = 'false';
        chip.dataset.userid = user.id;
        chip.textContent = `@${user.name}`;
        deleteRange.insertNode(chip);

        const after = document.createRange();
        after.setStartAfter(chip);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);

        document.execCommand('insertText', false, '\u00a0'); // non-breaking space after chip

        mentionedUserIds.current.add(user.id);
        setShowMentionDropdown(false);
        notifyChange();
    }, [notifyChange]);

    // ─── Keyboard nav in mention dropdown (+ Enter-to-send en modo compacto) ──
    const handleKeyDown = useCallback((e) => {
        if (showMentionDropdown) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedMention(s => Math.min(s + 1, filteredUsers.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedMention(s => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter' && filteredUsers[selectedMention]) { e.preventDefault(); insertMention(filteredUsers[selectedMention]); }
            else if (e.key === 'Escape') { setShowMentionDropdown(false); }
            return;
        }
        // Estilo WhatsApp/Slack: Enter envía, Shift+Enter hace salto de línea.
        // Solo aplica en modo compacto — el editor grande (descripción de
        // ticket nuevo, sin compact) sigue con Enter = salto de línea normal.
        if (compact && e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit?.();
        }
    }, [showMentionDropdown, filteredUsers, selectedMention, insertMention, compact, onSubmit]);

    // ─── Insertar texto plano en el cursor (emoji / respuesta rápida) ────────
    const insertTextAtCursor = useCallback((text) => {
        editorRef.current?.focus();
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !editorRef.current?.contains(sel.anchorNode)) {
            // Sin selección dentro del editor (ej. se hizo clic en el popover,
            // que le quitó el foco) — se agrega al final en vez de perderse.
            const range = document.createRange();
            range.selectNodeContents(editorRef.current);
            range.collapse(false);
            sel?.removeAllRanges();
            sel?.addRange(range);
        }
        document.execCommand('insertText', false, text);
        notifyChange();
    }, [notifyChange]);

    // ─── Remove attachment ────────────────────────────────────────────────
    const removeAttachment = (id) => {
        onAttachmentsChange?.(attachments.filter(a => a.id !== id));
    };

    // ─── File picker ──────────────────────────────────────────────────────
    // Antes, con 2+ archivos, cada FileReader.onload llamaba a onAttachmentsChange
    // por separado, todos cerrando sobre el mismo `attachments` (el valor de cuando
    // se disparó el evento, no el más reciente) — cada llamada pisaba el resultado
    // de la anterior en vez de sumarse, así que solo sobrevivía el último archivo en
    // terminar de leerse, sin ningún aviso de que los demás se perdieron (bug
    // encontrado el 2026-08-27; hoy no se dispara porque este input no tiene
    // "multiple", pero queda listo por si se habilita selección múltiple). Ahora se
    // espera a que TODAS las lecturas terminen y se agregan de una sola vez, en el
    // mismo orden en que se seleccionaron.
    const handleFileInput = (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (files.length === 0) return;

        const MAX_SIZE = 5 * 1024 * 1024; // 5MB
        const validFiles = files.filter(file => {
            if (file.size > MAX_SIZE) {
                alert(`El archivo ${file.name} supera el límite de 5MB.`);
                return false;
            }
            return true;
        });
        if (validFiles.length === 0) return;

        Promise.all(validFiles.map(file => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const id = `file_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                const isImage = file.type.startsWith('image/');
                resolve({ id, name: file.name, dataUrl: ev.target.result, type: isImage ? 'image' : 'file', size: file.size });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        }))).then(newAttachments => {
            onAttachmentsChange?.([...attachments, ...newAttachments]);
        }).catch(err => {
            console.error('Error al leer archivo(s):', err);
        });
    };

    // Botones de formato (Negrita/Cursiva/Código/Listas/Título/Enlace) — en
    // modo compacto viven detrás del botón "Aa" en vez de siempre visibles,
    // para que la barra en reposo quede angosta como WhatsApp/Slack.
    const formattingButtons = (
        <>
            <button type="button" className="rte-btn" title="Negrita (Ctrl+B)" onMouseDown={e => { e.preventDefault(); exec('bold'); }}><MdFormatBold size={16}/></button>
            <button type="button" className="rte-btn" title="Cursiva (Ctrl+I)" onMouseDown={e => { e.preventDefault(); exec('italic'); }}><MdFormatItalic size={16}/></button>
            <button type="button" className="rte-btn" title="Código" onMouseDown={e => { e.preventDefault(); exec('formatBlock', 'pre'); }}><MdCode size={16}/></button>
            <div className="rte-divider" />
            <button type="button" className="rte-btn" title="Lista con viñetas" onMouseDown={e => { e.preventDefault(); exec('insertUnorderedList'); }}><MdFormatListBulleted size={16}/></button>
            <button type="button" className="rte-btn" title="Lista numerada" onMouseDown={e => { e.preventDefault(); exec('insertOrderedList'); }}><MdFormatListNumbered size={16}/></button>
            <div className="rte-divider" />
            <button type="button" className="rte-btn" title="Título" onMouseDown={e => { e.preventDefault(); exec('formatBlock', 'h3'); }}><MdTitle size={16}/></button>
            <button type="button" className="rte-btn" title="Insertar enlace" onMouseDown={e => {
                e.preventDefault();
                const url = prompt('URL:');
                if (url) exec('createLink', url);
            }}><MdInsertLink size={16}/></button>
        </>
    );

    const mentionButton = (
        <button
            type="button"
            className="rte-btn"
            title="Mencionar usuario (@)"
            onMouseDown={e => {
                e.preventDefault();
                editorRef.current?.focus();
                document.execCommand('insertText', false, '@');
                handleInput();
            }}
        >
            <IoAtOutline size={compact ? 18 : 16}/>
        </button>
    );

    const attachButton = (
        <label className="rte-btn" title="Adjuntar archivo" style={{ cursor: 'pointer' }}>
            <IoAttachOutline size={compact ? 18 : 16}/>
            <input type="file" style={{ display: 'none' }} onChange={handleFileInput} accept="image/*,.pdf,.doc,.docx,.xlsx,.txt"/>
        </label>
    );

    return (
        <div className={`rte-wrapper ${noteMode ? 'note-mode' : ''} ${compact ? 'rte-compact' : ''}`} style={{ position: 'relative' }}>
            {compact ? (
                <>
                    {/* Toolbar de formato: colapsada detrás de "Aa" por default */}
                    {showFormatting && (
                        <div className="rte-toolbar">
                            {formattingButtons}
                        </div>
                    )}

                    {/* Fila principal: accesos rápidos + editor de 1 línea que crece */}
                    <div className="rte-quick-row">
                        <div className="rte-quick-tools">
                            {attachButton}
                            <div className="rte-popover-anchor">
                                <button
                                    type="button"
                                    className={`rte-btn ${showQuickReplies ? 'active' : ''}`}
                                    title="Respuestas rápidas"
                                    onMouseDown={e => { e.preventDefault(); setShowQuickReplies(s => !s); setShowEmojiPicker(false); }}
                                >
                                    <IoFlashOutline size={18}/>
                                </button>
                                {showQuickReplies && (
                                    <div className="rte-popover rte-quick-replies-popover">
                                        {QUICK_REPLIES.map((qr, i) => (
                                            <button
                                                type="button"
                                                key={i}
                                                className="rte-quick-reply-option"
                                                onMouseDown={e => { e.preventDefault(); insertTextAtCursor(qr); setShowQuickReplies(false); }}
                                            >
                                                {qr}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {mentionButton}
                            <div className="rte-popover-anchor">
                                <button
                                    type="button"
                                    className={`rte-btn ${showEmojiPicker ? 'active' : ''}`}
                                    title="Emoji"
                                    onMouseDown={e => { e.preventDefault(); setShowEmojiPicker(s => !s); setShowQuickReplies(false); }}
                                >
                                    <IoHappyOutline size={18}/>
                                </button>
                                {showEmojiPicker && (
                                    <div className="rte-popover rte-emoji-popover">
                                        {EMOJI_SET.map(em => (
                                            <button
                                                type="button"
                                                key={em}
                                                className="rte-emoji-option"
                                                onMouseDown={e => { e.preventDefault(); insertTextAtCursor(em); setShowEmojiPicker(false); }}
                                            >
                                                {em}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div
                            ref={editorRef}
                            className={`rte-editor rte-editor-compact ${expanded ? 'rte-editor-expanded' : ''}`}
                            contentEditable
                            suppressContentEditableWarning
                            data-placeholder={placeholder}
                            onInput={handleInput}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                        />

                        <button
                            type="button"
                            className="rte-btn rte-aa-toggle"
                            title="Opciones de formato"
                            onMouseDown={e => { e.preventDefault(); setShowFormatting(s => !s); }}
                        >
                            <IoTextOutline size={16}/>
                        </button>
                    </div>
                </>
            ) : (
                <>
                    {/* Toolbar (modo clásico, siempre visible — sin cambios) */}
                    <div className="rte-toolbar">
                        {formattingButtons}
                        <div className="rte-divider" />
                        {mentionButton}
                        {attachButton}
                    </div>

                    {/* Editable Area */}
                    <div
                        ref={editorRef}
                        className="rte-editor"
                        contentEditable
                        suppressContentEditableWarning
                        data-placeholder={placeholder}
                        onInput={handleInput}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                    />
                </>
            )}

            {/* Mention Dropdown */}
            {showMentionDropdown && filteredUsers.length > 0 && (
                <div
                    className="mention-dropdown"
                    style={{ position: 'absolute', top: mentionAnchor.top, left: mentionAnchor.left }}
                >
                    {filteredUsers.map((user, idx) => (
                        <div
                            key={user.id}
                            className={`mention-option ${idx === selectedMention ? 'selected' : ''}`}
                            onMouseDown={(e) => { e.preventDefault(); insertMention(user); }}
                        >
                            <div className="mention-avatar">{user.name.substring(0, 2).toUpperCase()}</div>
                            <div>
                                <div className="mention-name">{user.name}</div>
                                <div className="mention-role-tag">{user.role}</div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Attachment Previews */}
            {attachments.length > 0 && (
                <div className="rte-attachment-preview">
                    {attachments.map(att => (
                        <div key={att.id} className="rte-attachment-chip">
                            {att.type === 'image'
                                ? <img src={att.dataUrl} alt={att.name} className="rte-img-thumb" />
                                : <IoImage size={18} />
                            }
                            <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {att.name}
                            </span>
                            <button type="button" onClick={() => removeAttachment(att.id)} title="Quitar"><IoClose /></button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
