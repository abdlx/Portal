// Network guard library for Portal bubblewrap sandbox.
// Intercepts connect() to enforce strict network isolation:
// - Blocks host loopback (127.0.0.0/8, ::1)
// - Blocks private RFC1918 subnets (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
// - Blocks link-local (169.254.0.0/16, fe80::/10) and ULA (fc00::/7)
// - Enforces outbound public WAN access only on ports 80 (HTTP), 443 (HTTPS), 53 (DNS)
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <dlfcn.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <errno.h>

static int (*real_connect)(int, const struct sockaddr *, socklen_t) = NULL;

static int is_blocked_v4(uint32_t ip, uint16_t port) {
    uint8_t b1 = (ip >> 24) & 0xff;
    uint8_t b2 = (ip >> 16) & 0xff;

    // 127.0.0.0/8 (Loopback / localhost)
    if (b1 == 127) return 1;
    // 10.0.0.0/8 (RFC1918 Private)
    if (b1 == 10) return 1;
    // 172.16.0.0/12 (RFC1918 Private)
    if (b1 == 172 && (b2 >= 16 && b2 <= 31)) return 1;
    // 192.168.0.0/16 (RFC1918 Private / LAN)
    if (b1 == 192 && b2 == 168) return 1;
    // 169.254.0.0/16 (Link-local)
    if (b1 == 169 && b2 == 254) return 1;
    // 0.0.0.0/8 (Current network)
    if (b1 == 0) return 1;

    // Outbound WAN allowed ports: 80 (HTTP), 443 (HTTPS), 53 (DNS)
    if (port != 80 && port != 443 && port != 53) {
        return 1;
    }
    return 0;
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
    if (!real_connect) {
        real_connect = dlsym(RTLD_NEXT, "connect");
    }
    if (addr && addr->sa_family == AF_INET) {
        const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
        uint32_t ip = ntohl(in->sin_addr.s_addr);
        uint16_t port = ntohs(in->sin_port);
        if (is_blocked_v4(ip, port)) {
            errno = ECONNREFUSED;
            return -1;
        }
    } else if (addr && addr->sa_family == AF_INET6) {
        const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
        const unsigned char *b = in6->sin6_addr.s6_addr;
        uint16_t port = ntohs(in6->sin6_port);
        // ::1 loopback
        if (b[15] == 1) {
            int is_lo = 1;
            for (int i = 0; i < 15; i++) {
                if (b[i] != 0) is_lo = 0;
            }
            if (is_lo) {
                errno = ECONNREFUSED;
                return -1;
            }
        }
        // IPv4-mapped IPv6 ::ffff:x.x.x.x
        if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0 &&
            b[4] == 0 && b[5] == 0 && b[6] == 0 && b[7] == 0 &&
            b[8] == 0 && b[9] == 0 && b[10] == 0xff && b[11] == 0xff) {
            uint32_t ip = ((uint32_t)b[12] << 24) | ((uint32_t)b[13] << 16) | ((uint32_t)b[14] << 8) | (uint32_t)b[15];
            if (is_blocked_v4(ip, port)) {
                errno = ECONNREFUSED;
                return -1;
            }
        }
        // fe80::/10 link-local
        if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) {
            errno = ECONNREFUSED;
            return -1;
        }
        // fc00::/7 unique local
        if ((b[0] & 0xfe) == 0xfc) {
            errno = ECONNREFUSED;
            return -1;
        }
        // Outbound WAN allowed ports: 80, 443, 53
        if (port != 80 && port != 443 && port != 53) {
            errno = ECONNREFUSED;
            return -1;
        }
    }
    return real_connect(sockfd, addr, addrlen);
}
