import React, { useRef, useState, useCallback } from 'react';
import './RichTextEditor.css';
import { MdFormatBold, MdFormatItalic, MdFormatListBulleted, MdFormatListNumbered, MdCode, MdInsertLink, MdTitle } from 'react-icons/md';
import { IoAtOutline, IoClose, IoImage, IoAttachOutline } from 'react-icons/io5';

/**
 * RichTextEditor
 * Props:
 *   - onChange (fn)              : called with {html, text, mentionedUserIds, attachments}
 *   - placeholder (string)
 *   - noteMode (bool)            : amber styling
 *   - mentionableUsers (array)   : [{id, name, role}]
 *   - attachments (array)        : [{id, name, dataUrl, type}]
 *   - onAttachmentsChange (fn)   : called with updated attachments array
 */
export default function RichTextEditor({
    onChange,
    placeholder = 'Escribe aquí...',
    noteMode = false,
    mentionableUsers = [],
    attachments = [],
    onAttachmentsChange
}) {
    const editorRef = useRef(null);
    const [showMentionDropdown, setShowMentionDropdown] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionAnchor, setMentionAnchor] = useState({ top: 0, left: 0 });
    const [selectedMention, setSelectedMention] = useState(0);
    const mentionedUserIds = useRef(new Set());

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
                    // Insert inline preview into editor
                    editorRef.current?.focus();
                    document.execCommand('insertHTML', false, `<img src="${dataUrl}" alt="captura" style="max-width:100%;max-height:200px;border-radius:6px;margin:4px 0;display:block;"/>`);
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

    // ─── Keyboard nav in mention dropdown ────────────────────────────────
    const handleKeyDown = useCallback((e) => {
        if (!showMentionDropdown) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedMention(s => Math.min(s + 1, filteredUsers.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedMention(s => Math.max(s - 1, 0)); }
        else if (e.key === 'Enter' && filteredUsers[selectedMention]) { e.preventDefault(); insertMention(filteredUsers[selectedMention]); }
        else if (e.key === 'Escape') { setShowMentionDropdown(false); }
    }, [showMentionDropdown, filteredUsers, selectedMention, insertMention]);

    // ─── Remove attachment ────────────────────────────────────────────────
    const removeAttachment = (id) => {
        onAttachmentsChange?.(attachments.filter(a => a.id !== id));
    };

    // ─── File picker ──────────────────────────────────────────────────────
    const handleFileInput = (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;

        const MAX_SIZE = 5 * 1024 * 1024; // 5MB

        files.forEach(file => {
            if (file.size > MAX_SIZE) {
                alert(`El archivo ${file.name} supera el límite de 5MB.`);
                return;
            }

            const reader = new FileReader();
            reader.onload = (ev) => {
                const id = `file_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                const isImage = file.type.startsWith('image/');
                const newAttachment = { id, name: file.name, dataUrl: ev.target.result, type: isImage ? 'image' : 'file', size: file.size };
                
                // We update with callback pattern to ensure we don't overwrite concurrent uploads
                onAttachmentsChange?.([...attachments, newAttachment]);
            };
            reader.readAsDataURL(file);
        });
        e.target.value = '';
    };

    return (
        <div className={`rte-wrapper ${noteMode ? 'note-mode' : ''}`} style={{ position: 'relative' }}>
            {/* Toolbar */}
            <div className="rte-toolbar">
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
                <div className="rte-divider" />
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
                    <IoAtOutline size={16}/>
                </button>
                {/* File attach */}
                <label className="rte-btn" title="Adjuntar archivo" style={{ cursor: 'pointer' }}>
                    <IoAttachOutline size={16}/>
                    <input type="file" style={{ display: 'none' }} onChange={handleFileInput} accept="image/*,.pdf,.doc,.docx,.xlsx,.txt"/>
                </label>
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
