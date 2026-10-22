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
            row.getObject("id", UUID.class), row.getString("username"), row.getString("display_name"),
            row.getString("password_hash"), row.getString("role"), row.getTimestamp("created_at").toInstant());

    private final JdbcTemplate jdbc;

    public MemberRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Member> findByUsername(String username) {
        return jdbc.query("SELECT * FROM members WHERE username = ?", MAPPER, normalizeUsername(username))
                .stream().findFirst();
    }

    public static String normalizeUsername(String username) {
        return username.trim().toLowerCase(Locale.ROOT);
    }
}
