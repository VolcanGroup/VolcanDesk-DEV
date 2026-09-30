import React, { useState, useRef, useEffect } from 'react';
import { IoChevronDownOutline, IoCloseOutline, IoCheckmarkOutline } from 'react-icons/io5';
import './Multiselect.css';

export default function Multiselect({ label, options, selected = [], onChange, placeholder = 'Todos' }) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef(null);

    useEffect(() => {
        function handleClickOutside(event) {
            if (containerRef.current && !containerRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const toggleOption = (val) => {
        if (selected.includes(val)) {
            onChange(selected.filter(v => v !== val));
        } else {
            onChange([...selected, val]);
        }
    };

    const getDisplayText = () => {
        if (!selected || selected.length === 0) return placeholder;
        if (selected.length === options.length) return 'Todos';
        
        const labels = selected.map(val => {
            const found = options.find(opt => opt.value === val);
            return found ? found.label : val;
        });
        if (labels.length <= 2) {
            return labels.join(', ');
        }
        return `${labels.length} seleccionados`;
    };

    return (
        <div className="multiselect-container" ref={containerRef}>
            {label && <label className="multiselect-label">{label}</label>}
            <div 
                className={`multiselect-trigger ${isOpen ? 'active' : ''}`} 
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className={`multiselect-value ${(!selected || selected.length === 0) ? 'placeholder' : ''}`}>
                    {getDisplayText()}
                </span>
                <div className="multiselect-arrow-container">
                    {selected && selected.length > 0 && (
                        <button 
                            className="multiselect-clear-btn" 
                            onClick={(e) => {
                                e.stopPropagation();
                                onChange([]);
                            }}
                        >
                            <IoCloseOutline size={14} />
                        </button>
                    )}
                    <IoChevronDownOutline size={12} className={`multiselect-chevron ${isOpen ? 'open' : ''}`} />
                </div>
            </div>

            {isOpen && (
                <div className="multiselect-dropdown">
                    <div className="multiselect-options-list">
                        {options.map(opt => {
                            const isChecked = selected.includes(opt.value);
                            return (
                                <div 
                                    key={opt.value} 
                                    className={`multiselect-option-row ${isChecked ? 'selected' : ''}`}
                                    onClick={() => toggleOption(opt.value)}
                                >
                                    <input 
                                        type="checkbox" 
                                        checked={isChecked}
                                        onChange={() => {}} // controlled manually
                                        className="multiselect-checkbox-input"
                                    />
                                    <span className="multiselect-checkbox-box">
                                        {isChecked && <IoCheckmarkOutline size={12} strokeWidth={3} />}
                                    </span>
                                    <span className="multiselect-option-label">{opt.label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
