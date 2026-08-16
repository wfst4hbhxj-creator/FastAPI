from app.domain.provenance import ProvenanceField, DataStatus
from typing import Any

class DataValidator:
    @staticmethod
    def validate_number(field: ProvenanceField, min_val: float = None, max_val: float = None) -> ProvenanceField:
        if field.status != DataStatus.AVAILABLE:
            return field
            
        if field.value is None:
            field.status = DataStatus.INVALID
            field.reason = "Value is None but marked as AVAILABLE"
            return field
            
        try:
            val = float(field.value)
            if min_val is not None and val < min_val:
                field.status = DataStatus.INVALID
                field.reason = f"Value {val} below minimum {min_val}"
            elif max_val is not None and val > max_val:
                field.status = DataStatus.INVALID
                field.reason = f"Value {val} above maximum {max_val}"
        except (ValueError, TypeError):
            field.status = DataStatus.INVALID
            field.reason = f"Value is not a valid number: {field.value}"
            
        return field
