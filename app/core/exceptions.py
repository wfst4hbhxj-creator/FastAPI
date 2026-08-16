class ProviderException(Exception):
    """Base exception for provider errors."""
    def __init__(self, message: str, provider: str, status_code: int = None):
        self.message = message
        self.provider = provider
        self.status_code = status_code
        super().__init__(self.message)

class DataNotFoundException(ProviderException):
    """When a provider explicitly returns no data or 404."""
    pass

class RateLimitException(ProviderException):
    """When a provider rate limits."""
    pass
