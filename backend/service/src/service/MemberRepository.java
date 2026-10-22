package service;

import java.util.Locale;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class MemberRepository {

    private static final RowMapper<Member> MAPPER = (row, index) -> new Member(
            row.getObject("id", UUID.class), row.getString("email"), row.getString("display_name"),
            row.getString("password_hash"), row.getString("role"), row.getTimestamp("created_at").toInstant());

    private final JdbcTemplate jdbc;

    public MemberRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Member> findByEmail(String email) {
        return jdbc.query("SELECT * FROM members WHERE email = ?", MAPPER, normalizeEmail(email))
                .stream().findFirst();
    }

    public Member create(String email, String displayName, String passwordHash) {
        // 역할은 DB 기본값 USER를 사용한다. 클라이언트가 역할을 지정할 수 없다.
        return jdbc.queryForObject("""
                INSERT INTO members (id, email, display_name, password_hash)
                VALUES (?, ?, ?, ?) RETURNING *
                """, MAPPER, UUID.randomUUID(), normalizeEmail(email), displayName, passwordHash);
    }

    public static String normalizeEmail(String email) {
        return email.trim().toLowerCase(Locale.ROOT);
    }
}
