output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr_block" {
  value = aws_vpc.this.cidr_block
}

output "azs" {
  value = local.azs
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  value = aws_subnet.app[*].id
}

output "data_subnet_ids" {
  value = aws_subnet.data[*].id
}

output "app_security_group_id" {
  description = "Attach to every ECS service; data stores admit traffic from it."
  value       = aws_security_group.app.id
}

output "nat_public_ips" {
  description = "Egress IPs, e.g. for an Exotel or provider allowlist."
  value       = aws_eip.nat[*].public_ip
}
