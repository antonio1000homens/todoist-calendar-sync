variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone WAF Write for alf-broadcast.co.uk."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Zone ID for alf-broadcast.co.uk."
  type        = string
  default     = "0f12928eb058337bf9af778cb6e8ba90"
}
