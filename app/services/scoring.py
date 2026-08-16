from app.domain.fundamental import FundamentalData
from app.domain.provenance import DataStatus, ProvenanceField
from pydantic import BaseModel

class ScoreResult(BaseModel):
    score: ProvenanceField
    rating: ProvenanceField
    data_completeness: float

class ScoringService:
    @staticmethod
    def calculate_quality_score(fund: FundamentalData) -> ScoreResult:
        # Example naive scoring based on what's available
        total_fields = 5
        available_fields = 0
        
        score_val = 0.0
        if fund.eps.status == DataStatus.AVAILABLE and fund.eps.value is not None:
            available_fields += 1
            if fund.eps.value > 0:
                score_val += 20
                
        if fund.pe.status == DataStatus.AVAILABLE and fund.pe.value is not None:
            available_fields += 1
            if 0 < fund.pe.value < 15:
                score_val += 20
                
        if fund.pb.status == DataStatus.AVAILABLE and fund.pb.value is not None:
            available_fields += 1
            if 0 < fund.pb.value < 2:
                score_val += 20
                
        # For ROE and ROA, if unavailable, we DO NOT penalize the total score,
        # but we reflect it in data_completeness.
        if fund.roe.status == DataStatus.AVAILABLE and fund.roe.value is not None:
            available_fields += 1
            if fund.roe.value > 15:
                score_val += 20
                
        if fund.roa.status == DataStatus.AVAILABLE and fund.roa.value is not None:
            available_fields += 1
            if fund.roa.value > 5:
                score_val += 20

        completeness = available_fields / total_fields
        
        # Scale score based on available fields to avoid penalizing missing data
        final_score = None
        if available_fields > 0:
            final_score = (score_val / (available_fields * 20)) * 100
            
        rating_val = None
        if final_score is not None:
            if final_score >= 80:
                rating_val = "A"
            elif final_score >= 60:
                rating_val = "B"
            elif final_score >= 40:
                rating_val = "C"
            else:
                rating_val = "D"

        return ScoreResult(
            score=ProvenanceField(
                value=final_score,
                status=DataStatus.AVAILABLE if final_score is not None else DataStatus.UNAVAILABLE,
                calculated=True,
                calculation_method="scaled_sum_of_available_metrics",
                reason="missing_data" if final_score is None else None
            ),
            rating=ProvenanceField(
                value=rating_val,
                status=DataStatus.AVAILABLE if rating_val is not None else DataStatus.UNAVAILABLE,
                calculated=True,
                calculation_method="score_mapping",
                reason="missing_data" if rating_val is None else None
            ),
            data_completeness=completeness
        )
